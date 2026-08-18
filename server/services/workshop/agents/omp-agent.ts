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
import {
  registerHarnessProcess,
  bindHarnessProcess,
  markHarnessProcessExit,
  killHarnessProcess,
} from './harness-process'

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

export const HOST_TOOLS: RpcHostToolDefinition[] = [
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
    description: 'Send a message to another agent (lead or worker) in the same channel. Use priority "immediate" for urgent real-time messages that the recipient sees instantly during work; use "task" (default) for messages that queue until the recipient finishes their current task. Set require_reply=true to demand a response: the recipient must reply with their result via this same tool (honoring in_reply_to). When replying to a message, pass its message_id as in_reply_to and set require_reply only if you need further response.',
    parameters: {
      type: 'object',
      properties: {
        to_agent_id: { type: 'string', description: 'Recipient agent ID' },
        message: { type: 'string', description: 'Message content (when replying: your execution result + the content they asked for)' },
        priority: { type: 'string', enum: ['immediate', 'task'], description: 'Message priority: "immediate" = inject into recipient\'s running session instantly; "task" = queue for later consumption (default)' },
        require_reply: { type: 'boolean', description: 'Trigger: true = recipient MUST reply with result/content (default false)' },
        in_reply_to: { type: 'string', description: 'Message ID this reply refers to (set when replying to a trigger message)' },
      },
      required: ['to_agent_id', 'message'],
    },
  },
  {
    name: 'poll_messages',
    label: 'Poll Inbox',
    description: 'Check your inbox for unread messages from other agents. Returns messages that haven\'t been consumed yet. Replies to your trigger messages will appear here (and in-session if you are busy).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 10)' },
      },
    },
  },
  {
    name: 'read_channel_mail',
    label: 'Read Channel Mail',
    description: '(Lead only) Read the FULL channel mail log: every message exchanged between any agents (peer messages, replies, and task deliveries), newest first. Use this BEFORE dispatching a task whose result may already exist — if a worker already computed/delivered the value via mail, do NOT re-dispatch it; reference the concrete result from the mail instead.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max mails to return (default 50, max 500)' },
        agent_id: { type: 'string', description: 'Optional: only show mails involving this agent (as sender or recipient)' },
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
  {
    name: 'get_my_task_queue',
    label: 'My Queue',
    description: 'View your own task queue: pending tasks (FIFO order), the task you are currently executing, and completed tasks. Use this to check if you have unfinished work.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_queue_overview',
    label: 'Queue Overview',
    description: '(Lead only) Real-time overview of every team member: status (idle/busy), current task, pending queue length, completed count. Use this to make optimal scheduling and rebalancing decisions.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'reassign_task',
    label: 'Reassign Task',
    description: '(Lead only) Move a pending (not yet started) or failed task from one worker to another. Use for load rebalancing or when a worker is stuck. The old worker\'s queued delivery is revoked automatically.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to move' },
        to_agent_id: { type: 'string', description: 'Worker agent ID to receive the task' },
      },
      required: ['task_id', 'to_agent_id'],
    },
  },
  {
    name: 'update_task',
    label: 'Update Task',
    description: '(Lead only) Modify the title/description of a pending (queued, not started) task. The assignee\'s queued delivery is refreshed with the new content automatically.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to update' },
        title: { type: 'string', description: 'New title (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    label: 'Cancel Task',
    description: 'Cancel a task and remove it from the assignee\'s queue (lead can cancel any; assignee can cancel own). Pending queued deliveries are revoked automatically.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'search_memory',
    label: 'Search Memory',
    description: 'Search your persistent memory (hybrid keyword+semantic retrieval over your private memories and the channel\'s shared team memories). Use this ANY TIME you need prior context: before starting a task, when you suspect relevant past work exists, or when the injected memory hints mention something you need details on. Pass a focused query describing what you want to remember.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to recall, e.g. "数据库连接池配置结论" or "previous deployment checklist"' },
        scope: { type: 'string', enum: ['auto', 'private', 'shared'], description: 'Which memory domain to search: "auto" = your private + channel shared (default), "private" = only your own, "shared" = only channel-wide shared memories' },
        limit: { type: 'number', description: 'Max results (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_memory',
    label: 'Save Memory',
    description: 'Persist a distilled, reusable insight into memory for future tasks. scope="private" saves to YOUR personal memory (only you recall it); scope="shared" saves to the CHANNEL shared memory visible to ALL teammates (use for conclusions, conventions, or knowledge the whole team benefits from — not task-specific minutiae). Distill before saving: title = short topic, content = the reusable conclusion. Use a stable dedup_key to update an existing memory instead of duplicating.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short topic title, e.g. "API 网关限流方案结论"' },
        content: { type: 'string', description: 'The distilled reusable knowledge/conclusion (plain text)' },
        importance: { type: 'number', description: '0-1 importance (default 0.7 private / 0.85 shared)' },
        scope: { type: 'string', enum: ['private', 'shared'], description: '"private" = your memory only; "shared" = channel-wide shared memory for all teammates' },
        dedup_key: { type: 'string', description: 'Stable key for idempotent update (same key overwrites instead of duplicating)' },
      },
      required: ['title', 'content', 'scope'],
    },
  },
  {
    name: 'create_team_agent',
    label: 'Create Team Agent',
    description: '(Lead only) Create a NEW worker agent and add it to your channel\'s team, on the fly. Use ONLY when all workers stay busy with a persistent backlog, or when a task clearly needs a specialist that doesn\'t exist yet — not for routine tasks the current team can handle. The new member starts idle, appears in list_team_agents immediately, and can receive dispatch_task assignments right away. Give it a clear name and a system_prompt describing its specialty.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short, descriptive member name, e.g. "db-migrator" or "test-writer"' },
        harness: { type: 'string', enum: ['omp', 'mock', 'claude'], description: 'Agent harness: "omp" = full LLM agent with native work tools (default, use this for real work), "mock" = scripted test agent, "claude" = claude harness' },
        system_prompt: { type: 'string', description: 'System prompt prefix defining this member\'s specialty, working style, and conventions (maps to its systemPromptPrefix config)' },
        reason: { type: 'string', description: 'Why this member is being added (shown to the user in the team event timeline)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_team_agent',
    label: 'Update Team Agent',
    description: '(Lead only) Update an existing team member (worker): rename it, revise its system prompt (e.g. to specialize or correct its behavior), or enable/disable it. The member\'s runtime reloads with the new config on its next assignment. You cannot update yourself.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the worker agent to update (from list_team_agents)' },
        name: { type: 'string', description: 'New name (optional)' },
        system_prompt: { type: 'string', description: 'New system prompt prefix defining its specialty/conventions (optional)' },
        enabled: { type: 'boolean', description: 'true = activate member, false = disable member (disabled members receive no new tasks; default true)' },
        reason: { type: 'string', description: 'Why this change is made (shown in the team event timeline)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'remove_team_agent',
    label: 'Remove Team Agent',
    description: '(Lead only) Remove a worker from your channel\'s team. Its queued tasks are automatically re-dispatched to the remaining worker with the shortest queue (or failed for retry if it was mid-execution), so no work is lost — but the member\'s context is. Use ONLY for sustained idle surplus or persistent underperformance; never as an experiment, and avoid removing members with active work. You cannot remove yourself.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'ID of the worker agent to remove' },
        reason: { type: 'string', description: 'Why this member is removed (shown in the team event timeline)' },
      },
      required: ['agent_id'],
    },
  },
]

/** 仅 lead 可见的工具名(dispatch/调度/团队管理面;worker 注册时剔除,压缩工具上下文) */
const LEAD_ONLY_TOOL_NAMES = new Set([
  'dispatch_task',
  'get_queue_overview',
  'read_channel_mail',
  'reassign_task',
  'update_task',
  'create_team_agent',
  'update_team_agent',
  'remove_team_agent',
])

/** 按角色装配 host tools:lead = 全量;worker = 剔除 lead 专属(执行面 + 通信面 + 记忆面) */
export function hostToolsForRole(role: 'lead' | 'worker'): RpcHostToolDefinition[] {
  if (role === 'lead') return HOST_TOOLS
  return HOST_TOOLS.filter(t => !LEAD_ONLY_TOOL_NAMES.has(t.name))
}

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
  /**
   * 会话回合状态(steer 可靠注入的依据):
   * omp 的 steer 仅在回合 streaming 中生效——prompt 已入列但尚未开始输出时,
   * steer 会"成功"返回但被静默丢弃。因此注入方轮询直到回合输出开始(streamingStarted)
   * 才发送;若回合在等待期间结束,改走 follow_up(prompt 通道)兜底投递。
   */
  private streaming = false
  private turnActive = false
  /** 当前回合产生的 assistant 文本(供诊断) */
  private turnText = ''
  /** agent 身份信息(factory 注入;无需等待 init()) */
  private selfAgentId = ''
  private agentName = 'agent'
  private agentRole: 'lead' | 'worker' = 'worker'
  private channelId = ''
  /**
   * 当前待回执的触发上下文(自动关联兜底):
   * LLM 偶发省略 in_reply_to 参数 → 平台在 send_message_to_agent 时按上下文自动盖章,
   * 保证触发器回执关联契约不依赖模型传参纪律。
   */
  private replyContext: { fromId: string, messageId: string } | null = null

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

  /** harness 进程资源信息(运行时资源监控;进程未 spawn/已回收 → null) */
  getProcessInfo(): { pid: number, alive: boolean, command: string } | null {
    const client = this.client
    const pid = client?.pid
    if (!pid || !client) return null
    return { pid, alive: client.alive, command: 'omp --mode rpc' }
  }

  /** 强制终止 harness 进程(进程树;终止后由调用方停止对应 AgentRuntime) */
  killProcess(): void {
    const pid = this.client?.pid
    if (pid) {
      killHarnessProcess(pid)
    }
    else {
      this.client?.kill()
    }
  }

  /**
   * 实时消息注入(可靠):
   *  - 回合 streaming 中 → 立即 steer(同轮可见)
   *  - 回合活跃但尚未 streaming(prompt 排队窗口)→ 短轮询等待输出开始后再 steer
   *  - 回合已结束/空闲 → follow_up 作为新输入投递(仍会被模型处理并回复)
   * 兜底链保证:注入文本不会因为命中 omp 的静默丢弃窗口而丢失。
   */
  async steer(text: string): Promise<void> {
    // 从确定性触发横幅提取回执上下文(AgentRuntime.injectSteer 生成,格式固定):
    // "[实时消息 from <id>]: ..." + "[系统触发器] 本消息要求回复(reply_to=<messageId>)。"
    const banner = text.match(/\[实时消息 from ([^\]]+)]:[\s\S]*?要求回复\(reply_to=([0-9a-f-]{36})\)/)
    if (banner) {
      this.replyContext = { fromId: banner[1]!, messageId: banner[2]! }
    }
    const client = this.client
    if (!client) return
    try {
      if (this.streaming) {
        await client.send({ type: 'steer', message: text })
        return
      }
      if (this.turnActive) {
        // prompt 排队窗口:等 streaming 开始(上限 20s),期间回合结束则走 follow_up
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline && this.turnActive && !this.streaming) {
          const { promise, resolve } = Promise.withResolvers()
          setTimeout(resolve, 150)
          await promise
        }
        if (this.streaming && this.turnActive) {
          await client.send({ type: 'steer', message: text })
          return
        }
      }
      // 空闲或回合已结束:follow_up 开新输入(模型仍会处理;不再是"注入运行中会话"但内容不丢)
      await client.send({ type: 'follow_up', message: text })
    }
    catch (err) {
      console.error(`[OmpRpcAgent:${this.selfAgentId}] steer 注入失败:`, err instanceof Error ? err.message : err)
    }
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const kind = request.message.metadata?.['x-aw-task-kind']

    // worker: assign 消息 → 执行任务
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerRun(request, ctx)
      return
    }

    // worker/lead: 同事点对点消息(含实时通信触发器)→ 按触发器语义处理并回复
    if (!kind && request.fromAgentId) {
      yield* this.peerMessageRun(request, ctx)
      return
    }

    // 其余消息(lead 的 assign/child-completed 等):no-op(调度由 supervise() 处理)
  }

  // ===== supervise() =====

  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    await this.ensureClient(ctx)
    if (!this.client) return []

    const prompt = this.buildSupervisePrompt(snapshot, ctx.memory)
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
    const prompt = this.buildWorkerPrompt(taskId, taskText, request.memory)

    // 流式执行 + 事件映射
    yield* this.promptAndStream(prompt, taskId, ctx.signal)
  }

  /**
   * 点对点消息处理(实时通信驱动;lead 与 worker 通用)。
   * 触发器语义:metadata['x-aw-require-reply']='true' → 必须经 send_message_to_agent
   * 回给发送者:执行结果 + 对方所需内容,in_reply_to 关联原消息,并声明是否需再响应。
   */
  private async* peerMessageRun(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    try {
      await this.ensureClient(ctx)
    }
    catch {
      return
    }
    if (!this.client) return

    const fromId = request.fromAgentId ?? 'unknown'
    const msg = request.message
    const msgText = partsToText(msg.parts)
    const requireReply = msg.metadata?.['x-aw-require-reply'] === 'true'
    const isReply = typeof msg.metadata?.['x-aw-in-reply-to'] === 'string'
    this.replyContext = requireReply && fromId !== 'unknown'
      ? { fromId, messageId: msg.messageId }
      : null

    const roleLine = this.agentRole === 'lead'
      ? `You are "${this.agentName}", the LEAD coordinator of a multi-agent team (Channel: ${this.channelId}). A team member sent you a direct message.`
      : `You are "${this.agentName}", a worker agent in a multi-agent team (Channel: ${this.channelId}).`

    const lines: string[] = [
      roleLine,
      ...(request.memory ? [``, request.memory] : []),
      ``,
      `## Incoming Message`,
      `from: ${fromId}`,
      `message_id: ${msg.messageId}`,
      `requires_reply: ${requireReply}`,
      isReply ? `in_reply_to: ${String(msg.metadata?.['x-aw-in-reply-to'])}` : ``,
      ``,
      `Content:`,
      `"${msgText}"`,
      ``,
      `## How to Respond`,
    ]

    if (requireReply) {
      lines.push(
        `This message REQUIRES a reply (trigger). You must call send_message_to_agent with:`,
        `- to_agent_id: ${fromId}`,
        `- message: the result of handling this request + the content they asked for`,
        `- in_reply_to: ${msg.messageId}`,
        `- require_reply: set true ONLY if you need further response from them`,
        ``,
        `Do the requested work first (you may use your native tools), then send the reply.`,
      )
    }
    else {
      lines.push(
        `This message does not require a reply. Reply via send_message_to_agent only if genuinely useful`,
        `(e.g. they asked a question); otherwise a brief acknowledgment or no action is fine.`,
      )
    }

    if (this.agentRole === 'lead') {
      lines.push(
        ``,
        `As lead you own this channel's coordination AND team roster: if the message reveals work needs,`,
        `take action via dispatch_task / reassign_task (scheduling) or create_team_agent / update_team_agent /`,
        `remove_team_agent (roster); get_queue_overview and list_channel_tasks give you the live picture.`,
      )
    }

    yield* this.promptAndStream(lines.join('\n'), undefined, ctx.signal)
  }

  /** 消费待回执上下文(自动关联兜底):取走即清,避免跨消息污染 */
  private takeReplyContext(): { fromId: string, messageId: string } | null {
    const ctx = this.replyContext
    this.replyContext = null
    return ctx
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
    // 回合生命周期:prompt 已发出 → turnActive;首条 message_update → streaming;message_end/turn_end → 结束
    this.turnActive = true
    this.streaming = false
    this.turnText = ''
    const unsubState = client.onEvent((event) => {
      if (event.type === 'message_update') {
        if (event.assistantMessageEvent?.type === 'text_delta') {
          this.streaming = true
          this.turnText += event.assistantMessageEvent.delta ?? ''
          // LLM 流式增量透出(AEP agent.delta 事件源;P2):仅 worker/peer 转本走生成器
          const text = event.assistantMessageEvent.delta ?? ''
          if (text) enqueueDelta(text)
        }
      }
      if (event.type === 'message_end' || event.type === 'turn_end') {
        this.streaming = false
        flushDelta()
      }
      if (event.type === 'agent_end' && event.isTerminal !== false) {
        this.turnActive = false
        this.streaming = false
        flushDelta()
      }
      if (event.type === '__process_exit__' || event.type === '__error__') {
        this.turnActive = false
        this.streaming = false
      }
    })

    const enqueue = (event: AgentEvent): void => {
      queue.push(event)
      if (event.kind === 'done' || event.kind === 'error') isDone = true
      resolveWait?.()
      resolveWait = null
    }

    // LLM 流式增量缓冲:50ms 批量合并为一帧 delta(防高频 text_delta 洪泛 WS)
    let deltaBuf = ''
    let deltaTimer: ReturnType<typeof setTimeout> | null = null
    const flushDelta = (): void => {
      if (deltaTimer) {
        clearTimeout(deltaTimer)
        deltaTimer = null
      }
      if (!deltaBuf) return
      const text = deltaBuf
      deltaBuf = ''
      enqueue({ kind: 'delta', delta: { text } })
    }
    const enqueueDelta = (text: string): void => {
      deltaBuf += text
      deltaTimer ??= setTimeout(() => {
        deltaTimer = null
        flushDelta()
      }, 50)
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
      unsubState()
      this.turnActive = false
      this.streaming = false
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
        // 回合内的 provider/API 失败(限额 429、鉴权、上游 5xx 等):omp 把错误挂在最后一条
        // assistant 消息上(stopReason='error' + errorStatus/errorMessage)而非 __error__ 帧。
        // 不映射出来,上层只能看到「回合结束无产出」,真实原因彻底丢失(且照常重试到耗尽)。
        const failure = [...messages].reverse().find((m) => {
          const mm = m as { role?: string, stopReason?: string, errorMessage?: string }
          return mm.role === 'assistant' && (mm.stopReason === 'error' || typeof mm.errorMessage === 'string')
        }) as { errorStatus?: number, errorMessage?: string } | undefined
        if (failure) {
          const code = failure.errorStatus != null ? `OMP_LLM_${failure.errorStatus}` : 'OMP_LLM_ERROR'
          const detail = failure.errorMessage ?? 'harness 回合以错误结束(无错误详情)'
          console.error(`[OmpRpcAgent:${this.selfAgentId}] harness 回合失败 ${code}: ${detail}`)
          // error 事件即回合终点(队列侧据此收口),不再追加 done
          return [{ kind: 'error', error: { code, message: detail } }]
        }
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

  private buildWorkerPrompt(taskId: string, taskText: string, memory?: string): string {
    const prefix = this.config.systemPromptPrefix ?? ''
    const parts: string[] = []

    if (prefix) parts.push(prefix)
    if (memory) parts.push(memory)
    parts.push(
      `You are "${this.agentName}", a worker agent in a multi-agent team led by a lead coordinator (Channel: ${this.channelId}).`,
      ``,
      `## Your Assignment`,
      `Task ID: ${taskId}`,
      taskText,
      ``,
      `## Working Workflow`,
      `1. RECALL FIRST: the "相关记忆" block above is only an auto-recalled primer of hints. Before writing anything, call search_memory with focused queries about the task domain (past conclusions, team conventions, similar task outcomes — it searches both your private memory and the channel's shared memory). Reuse proven approaches instead of rediscovering them.`,
      `2. EXECUTE: use your native tools (read, write, edit, bash, grep, glob, etc.) to accomplish the task. Call report_progress whenever you make meaningful progress.`,
      `3. COLLABORATE: call list_team_agents to see teammates; send_message_to_agent to ask the lead or a teammate for help/clarification (they can reply in real time). Realtime messages marked "[实时消息 from ...]" may arrive mid-task — if one carries the reply trigger (系统触发器), handle it and reply via send_message_to_agent with in_reply_to=<its message_id>; your reply must contain the execution result and the content they asked for.`,
      `4. DISTILL: whenever you discover a reusable insight — a working solution, a project convention, a pitfall to avoid — call save_memory IMMEDIATELY (don't wait for task end): scope="private" for personal notes, scope="shared" to publish to the channel's shared memory so teammates benefit. Title = short topic; content = the distilled conclusion. Same dedup_key overwrites instead of duplicating.`,
      `5. DELIVER: call complete_task when done, providing a summary and the deliverable of your work. Keep it focused and effective.`,
      ``,
      `Begin working on the task now.`,
    )

    return parts.join('\n')
  }

  private buildSupervisePrompt(snapshot: SupervisionSnapshot, memory?: string): string {
    const prefix = this.config.systemPromptPrefix ?? ''
    const parts: string[] = []

    if (prefix) parts.push(prefix)
    if (memory) parts.push(memory)
    // 格式化成员(含队列上下文:执行中任务/待执行队列长度/已完成数 —— 最优调配的依据)
    const members = snapshot.members.map(m =>
      `  - ${m.agentId} (${m.name}, role=${m.role}, state=${m.state}, executing=${m.currentTaskId ?? '-'}, queued=${m.queued ?? 0}, completed=${m.completedCount ?? 0})`,
    ).join('\n')

    // 格式化任务(createdAt ASC = FIFO 顺序)
    const tasks = snapshot.tasks.map((t) => {
      const artifacts = t.artifacts.length > 0 ? `, artifacts=${t.artifacts.length}` : ''
      return `  - ${t.id} [${t.state}] "${t.title}" (assignee=${t.assigneeId}, progress=${t.progress}%${artifacts})`
    }).join('\n')

    // 未完成子任务数
    const pending = Object.entries(snapshot.pendingChildren)
      .map(([parentId, count]) => `  ${parentId}: ${count} pending`)
      .join('\n')

    // 最近邮件(最新在前):worker 间点对点通信/回执 —— 判断"结果是否已被产出"的依据
    const mail = (snapshot.mail ?? []).map((m) => {
      const from = m.fromAgentId ?? '(system)'
      const to = m.toAgentId ?? '(broadcast)'
      const body = m.parts.map(p => 'text' in p ? p.text : JSON.stringify('data' in p ? p.data : p)).join(' ').trim().slice(0, 140)
      const label = m.metadata?.['x-aw-task-kind'] === 'assign'
        ? 'task-assign'
        : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'peer'
      return `  - [${m.createdAt.slice(11, 19)}] ${from} → ${to} (${label}): ${body || '(empty)'}`
    }).join('\n')

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
      `## Team Members (state + task queues)`,
      members || '  (none)',
      ``,
      `## All Tasks (FIFO order)`,
      tasks || '  (none)',
      ``,
      `## Pending Children Count`,
      pending || '  (none)',
      ``,
      `## Recent Team Mail (newest first)`,
      mail || '  (none)',
    )

    // 模式特定指令
    if (modeInfo) {
      parts.push('', ...this.buildModeInstructions(modeInfo))
    }
    else {
      parts.push(
        ``,
        `## Your Job`,
        `You are a COORDINATOR. You do NOT do the work yourself. You ONLY delegate, track, and shape the team to maximize throughput.`,
        ``,
        `### Task Scheduling`,
        `- Tasks are processed FIFO (oldest first). For each task assigned to you that is SUBMITTED or WORKING and has NO children yet: it needs delegation. Call dispatch_task to delegate it. Prefer workers with the SHORTEST queue (see member queued counts). Always pass parent_task_id (the task's ID), assignee_id (the worker's ID), title, and description.`,
        `- BEFORE dispatching a task whose result may already exist, read the Recent Team Mail section above (or call read_channel_mail for the full log). If a worker has already computed/delivered that value via mail (e.g. a peer reply containing the result), do NOT re-dispatch it — reference the concrete result from the mail and avoid duplicate work.`,
        `- Rebalance when needed: reassign_task to move a pending task from a loaded worker to an idle one, update_task to revise a pending task, cancel_task to remove obsolete work. Use get_queue_overview for the live picture.`,
        `- Do NOT call complete_task on a task that has unfinished children. When all children of a parent are COMPLETED: call complete_task for the parent with a summary.`,
        `- Use list_team_agents and list_channel_tasks to get current IDs if needed.`,
        ``,
        `### Team Management (you own the team roster)`,
        `You can grow, tune, and shrink your team at runtime — the roster is yours to manage for maximum task completion.`,
        `However, roster changes are HIGH-IMPACT and visible to the user: treat them as deliberate decisions, not experiments.`,
        `- create_team_agent: add a new worker ONLY when (a) ALL workers stay busy and the backlog persists across multiple ticks, or (b) upcoming work needs a specialist that clearly doesn't exist. Give a clear name + system_prompt describing the specialty.`,
        `- update_team_agent: rename a member, revise its system_prompt to correct/specialize its behavior, or disable it (enabled=false stops new assignments without removing its history). Takes effect on its next task.`,
        `- remove_team_agent: retire a member ONLY for sustained idle surplus or persistent underperformance. NEVER remove a member that still has queued or in-progress work unless it is truly stuck; its tasks are re-dispatched but context is lost.`,
        `Defaults: for routine tasks keep the existing team unchanged. Prefer specializing an idle member (update) over creating duplicates; prefer reassignment (reassign_task) over removal when the issue is load, not capability. Always pass a honest reason. You cannot remove or update yourself.`,
        ``,
        `### Memory (your institutional knowledge)`,
        `- BEFORE scheduling recurring or previously-failed work, call search_memory: prior task outcomes, worker strengths, and channel conventions live there (e.g. "worker X excels at refactors", "approach Y failed before").`,
        `- AFTER observing durable team facts (a member's strength/weakness, an effective task-split pattern, a recurring pitfall), call save_memory with scope="shared" so every teammate can recall it. Use stable dedup_keys to refresh rather than duplicate.`,
        `- Do NOT use read/write/edit/bash or any work tools yourself. You are a coordinator, not a worker.`,
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
        `3. If NOT met: dispatch NEW subtasks to address the gaps; if no existing worker fits a gap, create_team_agent a specialist first.`,
        `4. If met: BEFORE completing, produce a FINAL CONCLUSION summarizing the end result. Call complete_task on the parent task with the deliverable set to a structured concluding summary that states: (a) the goal, (b) the judgment criteria, (c) what was completed (the child tasks), (d) the final outcome/result. Do NOT call complete_task without this concluding summary — the goal-mode close-out is incomplete without it.`,
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
      const command = this.config.command ?? 'omp'
      const client = new OmpRpcClient({
        command,
        args: this.config.args,
        cwd: this.config.cwd ?? process.cwd(),
        // 进程退出 → 注册表标记(供运行时资源监控);pid=-1 表示无法取得,忽略
        onExit: (pid, code) => {
          if (pid > 0) markHarnessProcessExit(pid, code)
        },
      })
      await client.start()

      // 登记 + 绑定 agent 身份(harness 进程监控的事实源)
      const pid = client.pid
      if (pid) {
        registerHarnessProcess(pid, {
          harness: 'omp',
          command,
          args: ['--mode', 'rpc', ...(this.config.args ?? [])],
        })
        bindHarnessProcess(pid, {
          agentId: this.selfAgentId,
          channelId: this.channelId,
          name: this.agentName,
          role: this.agentRole,
        })
      }

      // 设置模型(如果配置了)
      if (this.config.provider && this.config.model) {
        try {
          await client.send({ type: 'set_model', provider: this.config.provider, modelId: this.config.model })
        }
        catch {
          // 模型设置失败不致命(用 omp 默认模型)
        }
      }

      // 注册 host tools(按角色差异化:lead 全量,worker 剔除调度/团队管理专属工具)
      client.onHostToolCall(req => this.handleHostTool(req))
      await client.send({ type: 'set_host_tools', tools: hostToolsForRole(this.agentRole) })

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
          // 触发器:要求对方回复 / 标记本消息是对某消息的回复(回执关联)
          if (req.arguments.require_reply === true) metadata['x-aw-require-reply'] = 'true'
          let inReplyTo = req.arguments.in_reply_to as string | undefined
          // 自动关联兜底:LLM 省略 in_reply_to 时,按待回执上下文盖章
          // (触发消息要求回复 → 本次发送即回执;发给原发送者且无显式 in_reply_to)
          const replyCtx = this.takeReplyContext()
          if (!inReplyTo && replyCtx && replyCtx.fromId === toAgentId) {
            inReplyTo = replyCtx.messageId
            metadata['x-aw-in-reply-to'] = inReplyTo
          }
          const sent = await ws.sendMessage({ toAgentId, parts: [{ text: message }], metadata })
          const triggerNote = inReplyTo
            ? `(回复 ${inReplyTo.slice(0, 8)}…)`
            : metadata['x-aw-require-reply'] === 'true' ? '(已要求对方回复)' : ''
          return { text: `消息 ${sent.messageId.slice(0, 8)}… 已发送给 ${toAgentId}(priority=${priority})${triggerNote}` }
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

        case 'read_channel_mail': {
          const limit = (req.arguments.limit as number | undefined) ?? 50
          const agentId = req.arguments.agent_id as string | undefined
          const mails = await ws.listMail({ limit, agentId })
          if (mails.length === 0) return { text: 'Channel 无邮件记录(或该成员无往来)' }
          const text = mails.map((m) => {
            const from = m.fromAgentId ?? '(系统)'
            const to = m.toAgentId ?? '(广播)'
            const body = partsToText(m.parts).trim().slice(0, 120)
            const label = m.metadata?.['x-aw-task-kind'] === 'assign'
              ? '[任务指派]'
              : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? '[实时]' : '[协作]'
            return `  ${m.createdAt.slice(11, 19)} ${label} ${from} → ${to} (${m.state}): ${body || '(空)'}`
          }).join('\n')
          return { text: `Channel 邮件(${mails.length},倒序):\n${text}` }
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

        case 'get_my_task_queue': {
          const queue = await ws.myQueue()
          const fmt = (t: WorkspaceTask): string =>
            `  ${t.id} [${t.state}] "${t.title}" progress=${t.progress}%`
          return {
            text: [
              `我的任务队列(${this.agentRole}):`,
              `执行中: ${queue.current ? `${queue.current.id} "${queue.current.title}" (${queue.current.progress}%)` : '(无)'}`,
              `待执行(${queue.queued.length},FIFO):`,
              ...queue.queued.map(fmt),
              `已完成(${queue.completed.length}):`,
              ...queue.completed.map(fmt),
            ].join('\n'),
          }
        }

        case 'get_queue_overview': {
          const overview = await ws.queueOverview()
          const lines = overview.map(s =>
            `  ${s.agentId} (${s.name}, role=${s.role}, state=${s.state}, current=${s.currentTaskId ?? '-'}, queued=${s.queuedCount}, completed=${s.completedCount})`,
          )
          return { text: `团队队列总览(${overview.length}):\n${lines.join('\n') || '(空)'}` }
        }

        case 'reassign_task': {
          const taskId = req.arguments.task_id as string
          const toAgentId = req.arguments.to_agent_id as string
          const task = await ws.reassignTask(taskId, toAgentId)
          return { text: `任务 ${taskId}("${task.title}")已调配 → ${toAgentId}(state=${task.state})` }
        }

        case 'update_task': {
          const taskId = req.arguments.task_id as string
          const title = req.arguments.title as string | undefined
          const description = req.arguments.description as string | undefined
          const task = await ws.updateTask(taskId, { title, description })
          return { text: `任务 ${taskId} 已更新: "${task.title}"` }
        }

        case 'cancel_task': {
          const taskId = req.arguments.task_id as string
          await ws.cancelTask(taskId)
          return { text: `任务 ${taskId} 已取消并移出 assignee 队列` }
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

        case 'search_memory': {
          const query = req.arguments.query as string
          const scope = (req.arguments.scope as 'auto' | 'private' | 'shared' | undefined) ?? 'auto'
          const snippets = await ws.recallMemory({ query, scope, limit: req.arguments.limit as number | undefined })
          if (snippets.length === 0) {
            return { text: `记忆检索无命中(query="${query}", scope=${scope})。可尝试更换关键词或放宽 scope。` }
          }
          const lines = snippets.map(s =>
            `  [${s.source}·${s.kind}·score=${s.score}] ${s.title}\n    ${s.content}`,
          )
          return { text: `记忆检索结果(${snippets.length} 条, scope=${scope}):\n${lines.join('\n')}` }
        }

        case 'save_memory': {
          const title = req.arguments.title as string
          const content = req.arguments.content as string
          const scope = req.arguments.scope as 'private' | 'shared'
          const saved = await ws.saveMemory({
            title,
            content,
            importance: req.arguments.importance as number | undefined,
            scope,
            dedupKey: req.arguments.dedup_key as string | undefined,
          })
          const where = scope === 'shared' ? 'Channel 公共记忆(全员可检索)' : '本人私有记忆'
          return { text: `已沉淀到${where}: "${title}"(dedupKey=${saved.dedupKey})` }
        }

        case 'create_team_agent': {
          const name = req.arguments.name as string
          const harness = req.arguments.harness as string | undefined
          const systemPrompt = req.arguments.system_prompt as string | undefined
          const reason = req.arguments.reason as string | undefined
          const agent = await ws.createTeamMember({
            name,
            harness,
            config: systemPrompt ? { systemPromptPrefix: systemPrompt } : undefined,
            reason,
          })
          return {
            text: [
              `团队成员已创建并加入 channel:`,
              `  id: ${agent.id}`,
              `  name: ${agent.name}(role=worker, harness=${agent.harness})`,
              `新成员当前空闲,可立即 dispatch_task 指派任务;list_team_agents 可随时查看团队名册。`,
            ].join('\n'),
          }
        }

        case 'update_team_agent': {
          const agentId = req.arguments.agent_id as string
          const name = req.arguments.name as string | undefined
          const systemPrompt = req.arguments.system_prompt as string | undefined
          const enabled = req.arguments.enabled as boolean | undefined
          const reason = req.arguments.reason as string | undefined
          const agent = await ws.updateTeamMember(agentId, {
            name,
            config: systemPrompt !== undefined ? { systemPromptPrefix: systemPrompt } : undefined,
            enabled: enabled === undefined ? undefined : (enabled ? 1 : 0),
            reason,
          })
          return {
            text: `团队成员 ${agentId} 已更新:name="${agent.name}"${enabled !== undefined ? `, enabled=${enabled ? 1 : 0}` : ''};运行时将按新配置重载(下次任务生效)。`,
          }
        }

        case 'remove_team_agent': {
          const agentId = req.arguments.agent_id as string
          const reason = req.arguments.reason as string | undefined
          const result = await ws.removeTeamMember(agentId, reason)
          const recycleNote = result.recycledTasks.length > 0
            ? `其 ${result.recycledTasks.length} 个在途任务已回收(排队任务重派给剩余最短队列成员;执行中任务转 FAILED 待调度重试)。`
            : `该成员无在途任务。`
          return { text: `团队成员 ${agentId} 已移除。${recycleNote}` }
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
