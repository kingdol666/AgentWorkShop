/**
 * OmpRpcAgentImpl — omp harness 的完整 AgentInterface 实现。
 *
 * 通过 OmpRpcClient 驱动真实 omp 子进程(--mode rpc),将 omp 的原生 agent 能力
 * (LLM 推理 + 内置工具 read/write/edit/bash/grep/glob 等)接入 Workshop 的
 * Channel 编排体系。
 *
 * 核心设计:
 *  - 每个 Agent 实例持有一个 omp 子进程(lazy spawn,跨消息复用)
 *  - AgentWorkspace 方法注册为 omp host tools,agent 原生调用 report_progress /
 *    complete_task / dispatch_task / send_message 等,无需文本解析
 *  - omp AgentSessionEvent → AgentEvent 五变体映射
 *  - worker run():接收 assign → prompt omp → agent 用原生工具作业 + host tools 管理任务生命周期
 *  - lead supervise():格式化快照 → prompt omp → agent 直接用 host tools 执行调度决策 → 返回 []
 *  - dispose():杀子进程
 *
 * 协议权威:omp://rpc.md;AgentInterface 契约见 agent-interface.ts。
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentInterface,
  AgentInfo,
  AgentRunContext,
  AgentRunRequest,
  SupervisionDecision,
  SupervisionSnapshot,
} from './agent-interface'
import type { A2AArtifact, A2AMessage, Part } from '../types/a2a'
import type { WorkspaceTask } from '../types/task'
import {
  OmpRpcClient,
  type AgentSessionEvent,
  type RpcHostToolDefinition,
  type HostToolCallRequest,
} from './adapters/omp-rpc-client'

// ===== 配置 =====

export interface OmpAgentConfig {
  /** omp 可执行文件路径(默认 'omp',从 PATH 查找) */
  command?: string
  /** 额外 CLI 参数 */
  args?: string[]
  /** omp 工作目录(默认 process.cwd()) */
  cwd?: string
  /** 模型 provider(如 'anthropic'/'openai'/'zhipu');省略则用 omp 默认 */
  provider?: string
  /** 模型 ID;省略则用 omp 默认 */
  model?: string
  /** thinking level: off/minimal/low/medium/high/xhigh/max */
  thinkingLevel?: string
  /** 自定义系统 prompt 前缀(拼接到 agent 系统指令之前) */
  systemPromptPrefix?: string
  /** 限制 omp 仅使用指定内置工具(null = 全部) */
  toolNames?: string[]
  /** 每轮 prompt 超时(ms,默认 120000) */
  promptTimeoutMs?: number
  /** supervise 轮超时(ms,默认 60000) */
  superviseTimeoutMs?: number
  /** agent 身份(由 factory 从 AgentInfo 注入) */
  agentId?: string
  name?: string
  role?: 'lead' | 'worker'
  channelId?: string
}

// ===== host tool 定义(注册到 omp,agent 原生调用) =====

const HOST_TOOLS: RpcHostToolDefinition[] = [
  {
    name: 'report_progress',
    label: 'Report Progress',
    description: 'Report your current task progress as a percentage (0-100). Call this whenever you make meaningful progress on your task.',
    parameters: {
      type: 'object',
      properties: {
        progress: { type: 'number', description: 'Progress percentage 0-100' },
        message: { type: 'string', description: 'Brief status message describing what you are doing' },
      },
      required: ['progress'],
    },
  },
  {
    name: 'complete_task',
    label: 'Complete Task',
    description: 'Mark a task as completed with final deliverables. Workers call this when their assigned task is done. Lead calls this for parent tasks when all children are done.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was accomplished' },
        deliverable: { type: 'string', description: 'Final deliverable: code, analysis result, document content, etc.' },
        task_id: { type: 'string', description: 'Task ID to complete. If omitted, completes your current assigned task.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'dispatch_task',
    label: 'Dispatch Task',
    description: '(Lead only) Create a subtask under a submitted parent task and assign it to a worker. Always provide parent_task_id so the parent task tracks completion.',
    parameters: {
      type: 'object',
      properties: {
        assignee_id: { type: 'string', description: 'ID of the worker agent to assign this task to' },
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed task description with requirements' },
        parent_task_id: { type: 'string', description: 'The ID of the submitted parent task this subtask belongs to (from the task list)' },
      },
      required: ['assignee_id', 'title', 'parent_task_id'],
    },
  },
  {
    name: 'send_message_to_agent',
    label: 'Send Message',
    description: 'Send a message to another agent (lead or worker) in the same channel. Use priority "immediate" for urgent real-time messages that the recipient sees instantly during work; use "task" (default) for messages that queue until the recipient finishes their current task.',
    parameters: {
      type: 'object',
      properties: {
        to_agent_id: { type: 'string', description: 'Recipient agent ID' },
        message: { type: 'string', description: 'Message content' },
        priority: { type: 'string', enum: ['immediate', 'task'], description: 'Message priority: "immediate" = inject into recipient\'s running session instantly; "task" = queue for later consumption (default)' },
      },
      required: ['to_agent_id', 'message'],
    },
  },
  {
    name: 'poll_messages',
    label: 'Poll Inbox',
    description: 'Check your inbox for unread messages from other agents. Returns messages that haven\'t been consumed yet.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 10)' },
      },
    },
  },
  {
    name: 'broadcast_message',
    label: 'Broadcast',
    description: 'Broadcast a message to ALL agents in the channel (lead + all workers). Useful for announcements.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message content to broadcast' },
        priority: { type: 'string', enum: ['immediate', 'task'], description: 'Message priority (default "task")' },
      },
      required: ['message'],
    },
  },
  {
    name: 'list_channel_tasks',
    label: 'List Tasks',
    description: 'List all tasks in the current channel, including their status, progress, and assignee.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_team_agents',
    label: 'List Team',
    description: 'List all agents in the current channel (lead + workers) with their roles and names.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_details',
    label: 'Get Task',
    description: 'Get detailed information about a specific task, including artifacts and history.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
]

// ===== 辅助函数 =====

/** 从消息 parts 提取纯文本 */
function partsToText(parts: Part[]): string {
  return parts
    .map((p) => {
      if ('text' in p) return p.text
      if ('data' in p) return JSON.stringify(p.data)
      if ('url' in p) return p.url
      if ('raw' in p) return p.raw
      return ''
    })
    .join('\n')
}

/** 安全 JSON 解析(容错:提取第一个 JSON 数组/对象) */
function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim()
  // 直接尝试
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    return null
  }
  catch {
    // 继续
  }
  // 提取第一个 [ ... ] 块
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    }
    catch {
      // 继续
    }
  }
  return null
}

// ===== OmpRpcAgentImpl =====

export class OmpRpcAgentImpl implements AgentInterface {
  private readonly config: OmpAgentConfig
  private client: OmpRpcClient | null = null
  private workspace: AgentRunContext['workspace'] | null = null
  private agentInfo: AgentInfo | null = null
  private hostToolsRegistered = false
  /** 当前 run() 的 taskId(worker 完成任务时用) */
  private currentTaskId: string | null = null
  /** agent 身份信息(init 时缓存) */
  private selfAgentId = ''
  private agentName = 'agent'
  private agentRole: 'lead' | 'worker' = 'worker'
  private channelId = ''

  constructor(config: Record<string, unknown> = {}) {
    this.config = config as OmpAgentConfig
    // factory 注入的 agent 身份(无需等待 init())
    this.selfAgentId = this.config.agentId ?? ''
    this.agentName = this.config.name ?? 'agent'
    this.agentRole = this.config.role ?? 'worker'
    this.channelId = this.config.channelId ?? ''
  }

  // ===== 生命周期 =====

  async init(input: { agent: AgentInfo, channelId: string }): Promise<void> {
    this.agentInfo = input.agent
    this.channelId = input.channelId
    this.agentName = input.agent.name
    this.agentRole = input.agent.role
  }

  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.dispose()
      this.client = null
    }
    this.hostToolsRegistered = false
  }

  /** 实时消息注入:向正在运行的 omp 会话发送 steer 命令 */
  async steer(text: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.send({ type: 'steer', message: text })
    }
    catch {
      // 会话未在 streaming 时 steer 可能失败;静默忽略
    }
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const kind = request.message.metadata?.['x-aw-task-kind']

    // worker: assign 消息 → 执行任务
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerRun(request, ctx)
      return
    }

    // worker: 收到同事/lead 的非任务点对点消息 → 读取并简短回复
    if (!kind && ctx.role === 'worker' && request.fromAgentId) {
      yield* this.workerHandleMessage(request, ctx)
      return
    }

    // lead / 其他消息:no-op(调度由 supervise() 处理)
  }

  // ===== supervise() =====

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client) return []

    const prompt = this.buildSupervisePrompt(snapshot)
    const timeoutMs = this.config.superviseTimeoutMs ?? 60_000

    return new Promise<SupervisionDecision[]>((resolve) => {
      let assistantText = ''
      let resolved = false

      const finish = (decisions: SupervisionDecision[]) => {
        if (resolved) return
        resolved = true
        unsub()
        clearTimeout(timer)
        resolve(decisions)
      }

      const unsub = this.client!.onEvent((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          assistantText += event.assistantMessageEvent.delta ?? ''
        }
        if (event.type === 'agent_end' && event.isTerminal !== false) {
          // 尝试从文本解析 JSON 决策(备用:如果 agent 没用 host tools 而是输出 JSON)
          const parsed = extractJsonArray(assistantText)
          if (parsed && parsed.length > 0) {
            finish(parsed as SupervisionDecision[])
          }
          else {
            // agent 可能已通过 host tools 直接执行了调度,返回空(已执行)
            finish([])
          }
        }
        if (event.type === '__process_exit__' || event.type === '__error__') {
          finish([])
        }
      })

      const timer = setTimeout(() => finish([]), timeoutMs)

      this.client!.send({ type: 'prompt', message: prompt }).catch(() => finish([]))
    })
  }

  // ===== 内部:worker 执行 =====

  private async* workerRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId
      ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return

    this.currentTaskId = taskId

    try {
      await this.ensureClient(ctx)
    }
    catch (err) {
      yield {
        kind: 'error',
        error: {
          code: 'OMP_SPAWN_FAILED',
          message: `omp 子进程启动失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    if (!this.client) {
      yield { kind: 'error', error: { code: 'OMP_NOT_READY', message: 'omp 客户端未就绪' } }
      return
    }

    // 构建 prompt
    const taskText = partsToText(request.message.parts)
    const prompt = this.buildWorkerPrompt(taskId, taskText)

    // 流式执行 + 事件映射
    yield* this.promptAndStream(prompt, taskId, ctx.signal)
  }

  /** worker 处理非任务消息:读取同事消息并简短回复 */
  private async* workerHandleMessage(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    try {
      await this.ensureClient(ctx)
    }
    catch {
      return
    }
    if (!this.client) return

    const fromName = request.fromAgentId ?? 'unknown'
    const msgText = partsToText(request.message.parts)
    const prompt = [
      `You are "${this.agentName}", a worker agent in a multi-agent team.`,
      ``,
      `You received a message from agent ${fromName}:`,
      `"${msgText}"`,
      ``,
      `Respond briefly and helpfully. If this is a question, answer it concisely.`,
      `If this is information, acknowledge it briefly.`,
    ].join('\n')

    yield* this.promptAndStream(prompt, undefined, ctx.signal)
  }

  // ===== 内部:prompt 发送 + 事件流桥接 =====

  private async* promptAndStream(
    prompt: string,
    taskId: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const client = this.client
    if (!client) {
      throw new Error('omp 客户端未就绪')
    }
    const queue: AgentEvent[] = []
    let resolveWait: (() => void) | null = null
    let isDone = false

    const enqueue = (event: AgentEvent): void => {
      queue.push(event)
      if (event.kind === 'done' || event.kind === 'error') isDone = true
      resolveWait?.()
      resolveWait = null
    }

    // 订阅 omp 事件流
    const unsub = client.onEvent((event) => {
      for (const mapped of this.mapOmpEvent(event, taskId)) {
        enqueue(mapped)
      }
    })

    // abort 传导
    const onAbort = (): void => {
      client.send({ type: 'abort' }).catch(() => {})
      if (!isDone) {
        enqueue({ kind: 'done', final: taskId ? { taskId } : undefined })
      }
    }
    if (signal.aborted) {
      onAbort()
    }
    else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // 发送 prompt
    try {
      await client.send({ type: 'prompt', message: prompt })
    }
    catch (err) {
      unsub()
      signal.removeEventListener('abort', onAbort)
      yield {
        kind: 'error',
        error: {
          code: 'PROMPT_FAILED',
          message: `omp prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
      return
    }

    // 产出事件直到 done/error
    try {
      while (!isDone || queue.length > 0) {
        if (queue.length === 0 && !isDone) {
          await new Promise<void>((r) => {
            resolveWait = r
          })
        }
        while (queue.length > 0) {
          yield queue.shift()!
        }
      }
    }
    finally {
      unsub()
      signal.removeEventListener('abort', onAbort)
      this.currentTaskId = null
    }
  }

  // ===== 内部:omp 事件 → AgentEvent 映射 =====

  private mapOmpEvent(event: AgentSessionEvent, taskId: string | undefined): AgentEvent[] {
    switch (event.type) {
      case 'agent_start':
        return [{
          kind: 'status',
          status: { state: 'WORKING', timestamp: new Date().toISOString() },
        }]

      case 'message_end': {
        // 消息完成:如果有 message 内容,产出为 status 事件(任务历史追踪)
        const msg = event.message
        if (msg && Array.isArray(msg.content)) {
          const text = (msg.content as Array<{ type?: string, text?: string }>)
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('')
          if (text) {
            const a2aMsg: A2AMessage = {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text }],
            }
            return [{
              kind: 'status',
              status: { state: 'WORKING', message: a2aMsg, timestamp: new Date().toISOString() },
            }]
          }
        }
        return []
      }

      case 'tool_execution_start': {
        const toolName = event.toolName ?? 'tool'
        return [{
          kind: 'status',
          status: {
            state: 'WORKING',
            message: {
              messageId: randomUUID(),
              contextId: this.channelId,
              role: 'ROLE_AGENT',
              parts: [{ text: `🔧 ${toolName}` }],
            },
            timestamp: new Date().toISOString(),
          },
        }]
      }

      case 'agent_end': {
        if (event.isTerminal === false) return []
        const events: AgentEvent[] = []
        // 提取最终 assistant 文本作为 artifact
        const messages = event.messages ?? []
        const assistantText = messages
          .filter(m => m.role === 'assistant')
          .flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.text ?? ''))
          .join('')
        if (assistantText) {
          events.push({
            kind: 'artifact',
            artifact: {
              artifactId: randomUUID(),
              name: 'output',
              parts: [{ text: assistantText }],
            },
            lastChunk: true,
            totalChunks: 1,
          })
        }
        events.push({ kind: 'done', final: taskId ? { taskId } : undefined })
        return events
      }

      case '__process_exit__':
        return [{
          kind: 'error',
          error: { code: 'OMP_PROCESS_EXIT', message: 'omp 子进程意外退出' },
        }]

      case '__error__':
        return [{
          kind: 'error',
          error: { code: 'OMP_ERROR', message: (event as { error?: string }).error ?? 'omp 未知错误' },
        }]

      default:
        return []
    }
  }

  // ===== 内部:prompt 构建 =====

  private buildWorkerPrompt(taskId: string, taskText: string): string {
    const prefix = this.config.systemPromptPrefix ?? ''
    const parts: string[] = []

    if (prefix) parts.push(prefix)

    parts.push(
      `You are "${this.agentName}", a worker agent in a multi-agent team (Channel: ${this.channelId}).`,
      ``,
      `## Your Assignment`,
      `Task ID: ${taskId}`,
      taskText,
      ``,
      `## Instructions`,
      `1. Use your native tools (read, write, edit, bash, grep, glob, etc.) to accomplish the task.`,
      `2. Call report_progress whenever you make meaningful progress.`,
      `3. Call complete_task when you are done, providing a summary and deliverable of your work.`,
      `4. You may call list_team_agents to see your teammates, and send_message_to_agent to communicate.`,
      `5. Stay focused on the task. Be concise and effective.`,
      ``,
      `Begin working on the task now.`,
    )

    return parts.join('\n')
  }

  private buildSupervisePrompt(snapshot: SupervisionSnapshot): string {
    const prefix = this.config.systemPromptPrefix ?? ''
    const parts: string[] = []

    if (prefix) parts.push(prefix)

    // 格式化成员
    const members = snapshot.members.map(m =>
      `  - ${m.agentId} (${m.name}, role=${m.role}, state=${m.state})`,
    ).join('\n')

    // 格式化任务
    const tasks = snapshot.tasks.map((t) => {
      const artifacts = t.artifacts.length > 0 ? `, artifacts=${t.artifacts.length}` : ''
      return `  - ${t.id} [${t.state}] "${t.title}" (assignee=${t.assigneeId}, progress=${t.progress}%${artifacts})`
    }).join('\n')

    // 未完成子任务数
    const pending = Object.entries(snapshot.pendingChildren)
      .map(([parentId, count]) => `  ${parentId}: ${count} pending`)
      .join('\n')

    // 检测执行模式(从 lead 自己的任务 description 前缀)
    const leadTask = snapshot.tasks.find(t =>
      t.assigneeId === snapshot.members.find(m => m.role === 'lead')?.agentId
      && (t.state === 'SUBMITTED' || t.state === 'WORKING' || t.state === 'WAITING'),
    )
    const modeInfo = leadTask ? this.detectMode(leadTask.description ?? '') : null

    parts.push(
      `You are "${this.agentName}", the lead coordinator of a multi-agent team (Channel: ${this.channelId}).`,
      `Tick #${snapshot.tick}`,
      ``,
      `## Team Members`,
      members || '  (none)',
      ``,
      `## All Tasks`,
      tasks || '  (none)',
      ``,
      `## Pending Children Count`,
      pending || '  (none)',
    )

    // 模式特定指令
    if (modeInfo) {
      parts.push('', ...this.buildModeInstructions(modeInfo))
    }
    else {
      parts.push(
        ``,
        `## Your Job`,
        `You are a COORDINATOR. You do NOT do the work yourself. You ONLY delegate and track.`,
        `Analyze the team state and take action:`,
        `- For each task assigned to you that is SUBMITTED or WORKING and has NO children yet: it needs delegation. Call dispatch_task to delegate it to an idle worker. Always pass parent_task_id (the task's ID), assignee_id (the worker's ID), title, and description.`,
        `- Do NOT use read/write/edit/bash or any work tools yourself. You are a coordinator, not a worker.`,
        `- Do NOT call complete_task on a task that has unfinished children.`,
        `- If all children of a parent task are COMPLETED: call complete_task for the parent with a summary.`,
        `- Use list_team_agents and list_channel_tasks to get current IDs if needed.`,
      )
    }

    parts.push(
      ``,
      `Take action now using your tools. If no action is needed, simply reply "No action needed".`,
    )

    return parts.join('\n')
  }

  /** 从 description 前缀检测执行模式 */
  private detectMode(desc: string): { mode: string, criteria?: string, stages?: string[], interval?: number } | null {
    const match = desc.match(/^\[mode:(goal|loop|pipeline)\]/)
    if (!match) return null
    const mode = match[1]!
    const result: { mode: string, criteria?: string, stages?: string[], interval?: number } = { mode }
    if (mode === 'goal') {
      const crit = desc.match(/\[criteria:([^\]]+)\]/)
      if (crit) result.criteria = crit[1]
    }
    if (mode === 'loop') {
      const intv = desc.match(/\[interval:(\d+)\]/)
      if (intv) result.interval = parseInt(intv[1]!, 10)
    }
    if (mode === 'pipeline') {
      const stg = desc.match(/\[stages:([^\]]+)\]/)
      if (stg) result.stages = stg[1]!.split('->')
    }
    return result
  }

  /** 构建模式特定指令 */
  private buildModeInstructions(modeInfo: { mode: string, criteria?: string, stages?: string[], interval?: number }): string[] {
    const lines: string[] = [`## Execution Mode: ${modeInfo.mode.toUpperCase()}`]
    if (modeInfo.mode === 'goal') {
      lines.push(
        `You are working in GOAL mode. The goal must be fully satisfied before completing.`,
        modeInfo.criteria ? `**Goal Criteria**: ${modeInfo.criteria}` : '',
        ``,
        `## Your Job`,
        `1. Dispatch the task to a worker if it has no children yet.`,
        `2. When all children are COMPLETED: examine the artifacts and decide if the goal is met.`,
        `3. If NOT met: dispatch NEW subtasks to address the gaps.`,
        `4. If met: call complete_task on the parent task.`,
        `- Do NOT use work tools yourself. You are a coordinator.`,
      )
    }
    else if (modeInfo.mode === 'loop') {
      lines.push(
        `You are working in LOOP mode. The task repeats every ${(modeInfo.interval ?? 60000) / 1000}s.`,
        ``,
        `## Your Job`,
        `1. Dispatch the task to a worker if it has no children yet.`,
        `2. When the child is COMPLETED: complete the parent task. The system will re-submit it automatically.`,
        `- Do NOT use work tools yourself. You are a coordinator.`,
      )
    }
    else if (modeInfo.mode === 'pipeline') {
      const stageList = modeInfo.stages?.length
        ? modeInfo.stages.map((s, i) => `  Stage ${i + 1}: ${s}`).join('\n')
        : '  Decompose the task into sequential stages yourself.'
      lines.push(
        `You are working in PIPELINE mode. Execute stages sequentially.`,
        `## Pipeline Stages`,
        stageList,
        ``,
        `## Your Job`,
        `1. For the first incomplete stage: dispatch a child task to a worker.`,
        `2. Include the previous stage's output (from artifacts) in the description.`,
        `3. Do NOT start stage N+1 until stage N is COMPLETED.`,
        `4. When all stages are done: complete the parent task with the final deliverable.`,
        `- Do NOT use work tools yourself. You are a coordinator.`,
      )
    }
    return lines.filter(l => l !== '')
  }

  // ===== 内部:omp 客户端管理 =====

  private async ensureClient(ctx: AgentRunContext): Promise<void> {
    if (!this.workspace) {
      this.workspace = ctx.workspace
    }
    if (!this.agentInfo) {
      // init() 可能未调用;从 ctx 推断
      this.channelId = ctx.channelId
      this.agentRole = ctx.role
    }

    if (!this.client) {
      const client = new OmpRpcClient({
        command: this.config.command ?? 'omp',
        args: this.config.args,
        cwd: this.config.cwd ?? process.cwd(),
      })
      await client.start()

      // 设置模型(如果配置了)
      if (this.config.provider && this.config.model) {
        try {
          await client.send({ type: 'set_model', provider: this.config.provider, modelId: this.config.model })
        }
        catch {
          // 模型设置失败不致命(用 omp 默认模型)
        }
      }

      // 注册 host tools
      client.onHostToolCall(req => this.handleHostTool(req))
      await client.send({ type: 'set_host_tools', tools: HOST_TOOLS })

      this.client = client
      this.hostToolsRegistered = true
    }
  }

  // ===== 内部:host tool handler(workspace 桥接) =====

  private async handleHostTool(req: HostToolCallRequest): Promise<{ text: string, isError?: boolean }> {
    const ws = this.workspace
    if (!ws) {
      return { text: 'workspace 未就绪', isError: true }
    }

    try {
      switch (req.toolName) {
        case 'report_progress': {
          const progress = req.arguments.progress as number
          const message = req.arguments.message as string | undefined
          const taskId = this.currentTaskId
          if (!taskId) return { text: '无当前任务上下文', isError: true }
          await ws.reportTask({ taskId, progress, message })
          return { text: `进度已上报: ${progress}%${message ? ` (${message})` : ''}` }
        }

        case 'complete_task': {
          const summary = req.arguments.summary as string
          const deliverable = req.arguments.deliverable as string | undefined
          const taskId = (req.arguments.task_id as string | undefined) ?? this.currentTaskId
          if (!taskId) return { text: '无任务 ID', isError: true }
          // 父任务保护:有未完成子任务时拒绝完成(lead 须等 worker 交付)
          const allTasks = await ws.listTasks()
          const incompleteChildren = allTasks.filter(t => t.parentId === taskId && t.state !== 'COMPLETED' && t.state !== 'CANCELED')
          if (incompleteChildren.length > 0) {
            return {
              text: `任务 ${taskId} 有 ${incompleteChildren.length} 个未完成子任务,不能完成父任务。请等待子任务完成。`,
              isError: true,
            }
          }
          const artifacts: A2AArtifact[] = []
          if (deliverable || summary) {
            artifacts.push({
              artifactId: randomUUID(),
              name: 'deliverable',
              parts: [{ text: deliverable ?? summary }],
            })
          }
          await ws.completeTask(taskId, artifacts)
          return { text: `任务 ${taskId} 已完成` }
        }

        case 'dispatch_task': {
          const assigneeId = req.arguments.assignee_id as string
          const title = req.arguments.title as string
          const description = req.arguments.description as string | undefined
          const parentTaskId = req.arguments.parent_task_id as string | undefined
          const task = await ws.dispatchTask({ assigneeId, title, description, parentTaskId })
          return { text: `子任务 ${task.id} 已创建并指派 → ${assigneeId}(父任务 ${parentTaskId ?? '无'},标题: ${title})` }
        }

        case 'send_message_to_agent': {
          const toAgentId = req.arguments.to_agent_id as string
          const message = req.arguments.message as string
          const priority = (req.arguments.priority as string | undefined) ?? 'task'
          const metadata: Record<string, unknown> = {
            'x-aw-msg-priority': priority,
          }
          await ws.sendMessage({ toAgentId, parts: [{ text: message }], metadata })
          return { text: `消息已发送给 ${toAgentId}(priority=${priority})` }
        }

        case 'poll_messages': {
          const limit = (req.arguments.limit as number | undefined) ?? 10
          const msgs = await ws.pollMailbox(limit)
          if (msgs.length === 0) return { text: '收件箱为空(无未消费消息)' }
          const text = msgs.map((m) => {
            const from = m.metadata?.['x-aw-from-agent'] ?? '?'
            const body = m.parts.map(p => 'text' in p ? p.text : '').join(' ')
            return `  [from ${from}] ${body.slice(0, 100)}`
          }).join('\n')
          return { text: `未消费消息(${msgs.length}):\n${text}` }
        }

        case 'broadcast_message': {
          const message = req.arguments.message as string
          const priority = (req.arguments.priority as string | undefined) ?? 'task'
          const agents = await ws.listAgents()
          const others = agents.filter(a => a.id !== this.selfAgentId)
          for (const agent of others) {
            await ws.sendMessage({
              toAgentId: agent.id,
              parts: [{ text: message }],
              metadata: { 'x-aw-msg-priority': priority },
            })
          }
          return { text: `已广播给 ${others.length} 个 agent(priority=${priority})` }
        }

        case 'list_channel_tasks': {
          const tasks = await ws.listTasks()
          const text = tasks.map(t =>
            `  ${t.id} [${t.state}] "${t.title}" assignee=${t.assigneeId} progress=${t.progress}%`,
          ).join('\n')
          return { text: `Channel 任务(${tasks.length}):\n${text || '(空)'}` }
        }

        case 'list_team_agents': {
          const agents = await ws.listAgents()
          const text = agents.map(a =>
            `  ${a.id} (${a.name}, role=${a.role}, harness=${a.harness})`,
          ).join('\n')
          return { text: `团队成员(${agents.length}):\n${text || '(空)'}` }
        }

        case 'get_task_details': {
          const taskId = req.arguments.task_id as string
          const task: WorkspaceTask = await ws.getTask(taskId)
          const artifactText = task.artifacts.map(a =>
            `  artifact ${a.artifactId}: ${a.parts.map(p => 'text' in p ? p.text.slice(0, 100) : '').join('; ')}`,
          ).join('\n')
          return {
            text: `任务 ${task.id}\n  状态: ${task.state}\n  标题: ${task.title}\n  描述: ${task.description ?? '-'}\n  指派: ${task.assigneeId}\n  进度: ${task.progress}%\n  成果:\n${artifactText || '  (无)'}`,
          }
        }

        default:
          return { text: `未知工具: ${req.toolName}`, isError: true }
      }
    }
    catch (err) {
      return {
        text: `工具执行异常(${req.toolName}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
