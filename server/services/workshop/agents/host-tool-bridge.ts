/**
 * HostToolBridge —— workspace 工具桥(harness 无关)。
 *
 * 把 omp-agent 时代的 host tool 定义/角色装配/分发逻辑抽为共享模块:
 *  - omp:保持原生 host_tool_call → dispatch(经本桥);
 *  - codex/dsh/opencode:经 stdio MCP 桥(server/harness/aw-mcp-bridge.mjs)
 *    → HTTP agent-tools 面 → impl.dispatchHostTool → 同一本桥;
 *  - REST 直调(agent-tools/invoke)同样落本桥。
 * 从而"工具注册一套逻辑、注入与分发全引擎一致"。
 *
 * 分发语义与原 omp 实现逐字节对齐:插件工具优先 → workspace 协作/任务/记忆面 →
 * 工业工具族 → 插件兜底 → 未知工具报错。
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentInfo,
  AgentWorkspace,
} from './agent-interface'
import type { A2AArtifact, Part } from '../types/a2a'
import type { WorkspaceTask } from '../types/task'
import type { RpcHostToolDefinition } from './adapters/omp-rpc-client'
import { loadHostToolDefs } from '../prompts/loader'
import { toolDaqFrames, toolDaqQuery, toolDcwControl, toolDcwJudge, toolDcwJournal, toolDcwRead, toolDcwRollback, toolMyIndustrialNodes } from './industrial-tools'
import { listPluginTools } from './plugin-tools'
import { extractTaskMode } from '../runtime/execution-mode'

/** host tool 定义(外置 .AgentWorkShop/prompts/host-tools.json;加载器缓存) */
export const HOST_TOOLS: RpcHostToolDefinition[] = loadHostToolDefs()

/** 仅 lead 可见的工具名(dispatch/调度/团队管理面;worker 注册时剔除,压缩工具上下文) */
export const LEAD_ONLY_TOOL_NAMES = new Set([
  'dispatch_task',
  'get_queue_overview',
  'read_channel_mail',
  'reassign_task',
  'update_task',
  'create_team_agent',
  'update_team_agent',
  'remove_team_agent',
])

/**
 * 按角色装配 host tools:lead = 全量;worker = 剔除 lead 专属(执行面 + 通信面 + 记忆面);
 * 尾部合并插件注册工具(roles 过滤,缺省双角色可用)。
 * 全 harness 共用:omp 经 set_host_tools 下发;其余引擎经 MCP 桥 tools/list 拉取。
 */
export function hostToolsForRole(role: 'lead' | 'worker'): RpcHostToolDefinition[] {
  const base = role === 'lead'
    ? HOST_TOOLS
    : HOST_TOOLS.filter(t => !LEAD_ONLY_TOOL_NAMES.has(t.name))
  const out = [...base]
  for (const [name, tool] of listPluginTools()) {
    if (out.some(t => t.name === name)) continue
    if (tool.roles && !tool.roles.includes(role)) continue
    out.push({ name, label: tool.label ?? name, description: tool.description, parameters: tool.parameters ?? {} })
  }
  return out
}

/** 工具调用请求(与引擎协议解耦的规范化形状) */
export interface HostToolCall {
  toolName: string
  arguments: Record<string, unknown>
}

export interface HostToolResult {
  text: string
  isError?: boolean
}

/** 会话态(impl 持有,桥读写):当前执行任务 + 待回执上下文 */
export interface HostToolSessionState {
  currentTaskId: string | null
  replyContext: { fromId: string, messageId: string } | null
}

export function createSessionState(): HostToolSessionState {
  return { currentTaskId: null, replyContext: null }
}

/** 桥上下文:impl 注入身份与 workspace 取值器 */
export interface HostToolBridgeContext {
  identity: { agentId: string, channelId: string, role: 'lead' | 'worker', name: string }
  state: HostToolSessionState
  getWorkspace(): AgentWorkspace | null
}

/** 从消息 parts 提取纯文本(多 harness 共用) */
export function partsToText(parts: Part[]): string {
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

/**
 * 分发一次 host tool 调用(全引擎唯一入口):
 * 插件工具优先 → workspace 面 → 工业工具族 → 插件兜底 → 未知工具。
 */
export async function dispatchHostTool(ctx: HostToolBridgeContext, req: HostToolCall): Promise<HostToolResult> {
  const identity = ctx.identity
  // 插件工具分发(ctx.omp.registerTool 注册的自定义工具;不依赖 workspace,优先于内置面)
  const pluginTool = listPluginTools().get(req.toolName)
  if (pluginTool) {
    try {
      return await pluginTool.handler(req.arguments ?? {}, identity)
    }
    catch (err) {
      return {
        text: `工具执行异常(${req.toolName}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
  const args = req.arguments ?? {}

  // 工业工具族不依赖 workspace(只按 agentId 查绑定与节点),先于 workspace 门控执行 ——
  // 否则 worker 首回合前的 REST/MCP 直调(my_industrial_nodes 等)会被误拒
  switch (req.toolName) {
    case 'my_industrial_nodes':
      return toolMyIndustrialNodes(identity.agentId)
    case 'dcw_control':
      return toolDcwControl(identity.agentId, args as { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string })
    case 'dcw_read':
      return toolDcwRead(identity.agentId, args as { node_id?: string })
    case 'daq_query':
      return toolDaqQuery(identity.agentId, args as Parameters<typeof toolDaqQuery>[1])
    case 'daq_frames':
      return toolDaqFrames(identity.agentId, args as Parameters<typeof toolDaqFrames>[1])
    case 'dcw_judge':
      return toolDcwJudge(identity.agentId, args as { record_id?: string, verdict?: string, reason?: string })
    case 'dcw_rollback':
      return toolDcwRollback(identity.agentId, args as { record_id?: string, node_id?: string, to?: string })
    case 'dcw_journal':
      return toolDcwJournal(identity.agentId, args as { node_id?: string, recipe_id?: string, limit?: number | string })
  }

  const ws = ctx.getWorkspace()
  if (!ws) {
    return { text: 'workspace 未就绪', isError: true }
  }

  try {
    switch (req.toolName) {
      case 'report_progress': {
        const progress = args.progress as number
        const message = args.message as string | undefined
        const taskId = ctx.state.currentTaskId
        if (!taskId) return { text: '无当前任务上下文', isError: true }
        await ws.reportTask({ taskId, progress, message })
        return { text: `进度已上报: ${progress}%${message ? ` (${message})` : ''}` }
      }

      case 'complete_task': {
        const summary = args.summary as string
        const deliverable = args.deliverable as string | undefined
        const taskId = (args.task_id as string | undefined) ?? ctx.state.currentTaskId
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
        // 终态幂等:任务已被平台收口(看门狗取消/调度器完成)时不撞状态机 ——
        // 给 Agent 明确的"无需再完成,继续下一项"信号,杜绝重复重试烧 token
        const current = await ws.getTask(taskId)
        if (current && current.state !== 'SUBMITTED' && current.state !== 'ASSIGNED' && current.state !== 'WORKING' && current.state !== 'WAITING') {
          if (current.state === 'COMPLETED') {
            return { text: `任务 ${taskId} 已是完成状态(可能已被平台收口),无需重复完成。` }
          }
          try {
            const q = await ws.myQueue()
            const next = q.queued[0]
            return {
              text: `任务 ${taskId} 已被平台${current.state === 'CANCELED' ? '取消(如停滞回收/上级作废)' : '判定失败'},不能再标记完成 —— 这不是你的错误,也无需重试。${next ? `队列还有 ${q.queued.length} 项,下一项「${next.title}」即将开始,请继续处理。` : '队列为空,保持待命。'}`,
              isError: false,
            }
          }
          catch {
            return { text: `任务 ${taskId} 已被平台${current.state === 'CANCELED' ? '取消' : '判定失败'},无需再完成,请继续处理队列下一项。` }
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
        ctx.state.currentTaskId = null
        // 完成即衔接:报告队列余量与下一项(状态同步 + 驱动继续处理)
        try {
          const q = await ws.myQueue()
          const next = q.queued[0]
          if (next) {
            return {
              text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED)。你的队列还有 ${q.queued.length} 项待处理,下一项:「${next.title}」(即将自动开始;收到任务指派消息后按工作流执行,完成后同样调用 complete_task)。`,
            }
          }
          return { text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED),队列为空。保持待命:新任务/实时消息会自动到达你的信箱。` }
        }
        catch {
          return { text: `任务 ${taskId} 已完成(状态已同步为 COMPLETED)。` }
        }
      }

      case 'dispatch_task': {
        const assigneeId = args.assignee_id as string
        const title = args.title as string
        const description = args.description as string | undefined
        const parentTaskId = args.parent_task_id as string | undefined
        const routeReason = args.route_reason as string | undefined
        // 重复派发守卫(真实场景实测:lead 模型可能对同一目标重复派发,引发协调风暴):
        // 同父任务下已存在同标题非终态子任务 → 不再创建,直接指路既有任务
        const dup = await ws.listTasks()
        const existing = dup.find(t =>
          t.parentId === parentTaskId
          && t.title === title
          && t.state !== 'COMPLETED' && t.state !== 'FAILED' && t.state !== 'CANCELED')
        if (existing) {
          return {
            text: `未创建:同父任务下已存在同标题进行中子任务 ${existing.id}("${existing.title}",state=${existing.state},assignee=${existing.assigneeId})。请勿重复派发;若需跟进请对该任务 notify 或 reassign。`,
          }
        }
        const task = await ws.dispatchTask({ assigneeId, title, description, parentTaskId, routeReason })
        return { text: `子任务 ${task.id} 已创建并指派 → ${assigneeId}(父任务 ${parentTaskId ?? '无'},标题: ${title}${routeReason ? `,路由理由: ${routeReason}` : ''})` }
      }

      case 'send_message_to_agent': {
        const toAgentId = args.to_agent_id as string
        const message = args.message as string
        // 回执自动实时:回复(in_reply_to)默认提升为 immediate——
        // 接收方正等待该结果,realtime 路由会把回复直接注入其运行中的会话
        let priority = (args.priority as string | undefined) ?? 'task'
        const metadata: Record<string, unknown> = {}
        if (args.require_reply === true) metadata['x-aw-require-reply'] = 'true'
        let inReplyTo = args.in_reply_to as string | undefined
        // 自动关联兜底:LLM 省略 in_reply_to 时,按待回执上下文盖章
        const replyCtx = ctx.state.replyContext
        ctx.state.replyContext = null
        if (!inReplyTo && replyCtx && replyCtx.fromId === toAgentId) {
          inReplyTo = replyCtx.messageId
        }
        if (inReplyTo) {
          metadata['x-aw-in-reply-to'] = inReplyTo
          if (priority === 'task') priority = 'immediate'
        }
        metadata['x-aw-msg-priority'] = priority
        const sent = await ws.sendMessage({ toAgentId, parts: [{ text: message }], metadata })
        const triggerNote = inReplyTo
          ? `(回复 ${inReplyTo.slice(0, 8)}…,已实时推送给对方)`
          : metadata['x-aw-require-reply'] === 'true' ? '(已要求对方回复)' : ''
        return { text: `消息 ${sent.messageId.slice(0, 8)}… 已发送给 ${toAgentId}(priority=${priority})${triggerNote}` }
      }

      case 'send_cross_channel_message': {
        const toChannelId = args.to_channel_id as string
        const message = args.message as string
        if (!toChannelId || !message) return { text: '缺少 to_channel_id 或 message', isError: true }
        try {
          const r = await ws.sendCrossChannelMessage({
            toChannelId,
            parts: [{ text: message }],
            requireReply: args.require_reply === true,
            inReplyTo: args.in_reply_to as string | undefined,
          })
          const note = args.require_reply === true ? '(已要求对方 Leader 回复)' : ''
          return { text: `跨 Channel 消息 ${r.messageId.slice(0, 8)}… 已送达 channel「${r.toChannelName}」的 Leader(${r.toLeadAgentId.slice(0, 8)}…)${note}。对方将按你的信息需求处理;其回复会经 mailbox 到达你这里。` }
        }
        catch (err) {
          return { text: `跨 Channel 发送失败: ${err instanceof Error ? err.message : String(err)}(仅 Leader 可跨 Channel 通信)`, isError: true }
        }
      }

      case 'list_other_teams': {
        const teams = await ws.listOtherTeams()
        if (teams.length === 0) return { text: '当前没有其他团队(或均未启用)。' }
        const text = teams.map((t) => {
          const active = t.activeTasks.length > 0
            ? t.activeTasks.map(x => `「${x.title}」(${x.state})`).join('、')
            : '无进行中任务'
          const done = t.recentCompleted.length > 0
            ? t.recentCompleted.map(x => `「${x.title}」`).join('、')
            : '无'
          const mem = t.sharedMemories > 0 ? `共享记忆 ${t.sharedMemories} 条(可检索)` : '暂无共享记忆'
          return `- ${t.name}${t.description ? `(${t.description})` : ''} · lead=${t.leadName ?? '?'} · ${mem}\n  进行中: ${active}\n  近期完成: ${done}\n  channel_id: ${t.channelId}`
        }).join('\n')
        return { text: `其他团队概览:\n${text}\n(需要协作时用 send_cross_channel_message 向对应团队 Leader 发信;查具体知识用 search_other_teams_memory)` }
      }

      case 'search_other_teams_memory': {
        const query = (args.query as string | undefined) ?? ''
        if (!query) return { text: '缺少 query', isError: true }
        const rows = await ws.searchOtherTeamsMemory({ query, limit: Number(args.limit ?? 5) })
        if (rows.length === 0) return { text: `其他团队的共享记忆中没有命中「${query}」的内容。` }
        const text = rows.map(r =>
          `- [${r.channelName}] 「${r.title}」(${r.createdAt.slice(0, 10)}): ${r.content}`).join('\n')
        return { text: `其他团队共享记忆命中 ${rows.length} 条:\n${text}` }
      }

      case 'refuse_task': {
        const taskId = args.task_id as string
        const reason = args.reason as string
        if (!taskId || !reason) return { text: '缺少 task_id 或 reason', isError: true }
        const r = await ws.refuseTask(taskId, reason)
        const notified = r.notifiedTo ? `拒绝回执已送达 ${r.notifiedTo.slice(0, 8)}` : '无回执对象(创建者已不在 channel)'
        return {
          text: `任务 ${taskId.slice(0, 8)}("${r.task.title}") 已拒绝(state=${r.task.state});${notified}。调度器将改派他人,请勿再处理该任务。`,
        }
      }

      case 'poll_messages': {
        const limit = (args.limit as number | undefined) ?? 10
        const waitSec = Math.min(180, Math.max(0, Number(args.wait_seconds ?? 0) || 0))
        const msgs = await ws.waitMailbox(limit, waitSec * 1000)
        if (msgs.length === 0) {
          return {
            text: waitSec > 0
              ? `等待 ${waitSec}s 后收件箱仍为空。若此前已有"[实时消息 from X]"注入你的会话,那就是回复本身(无需再轮询);否则可继续处理其他工作,对方回复会以新回合送达。`
              : '收件箱为空(无未消费消息)。等待回复请用 wait_seconds 参数阻塞等待,不要反复空轮询。',
          }
        }
        // 读即取:协作消息(非任务投递)取出即确认;任务指派(assign)不确认
        const ackIds = msgs
          .filter(m => !m.metadata?.['x-aw-task-kind'])
          .map(m => m.messageId)
        if (ackIds.length > 0) await ws.ackMailbox(ackIds)
        const trigger = msgs.find(m =>
          m.metadata?.['x-aw-require-reply'] === 'true'
          && typeof m.metadata?.['x-aw-from-agent'] === 'string')
        if (trigger) {
          ctx.state.replyContext = {
            fromId: String(trigger.metadata!['x-aw-from-agent']),
            messageId: trigger.messageId,
          }
        }
        const text = msgs.map((m, i) => {
          const from = m.metadata?.['x-aw-from-agent'] ?? '?'
          const reply = m.metadata?.['x-aw-in-reply-to']
            ? ` (回复 ${String(m.metadata['x-aw-in-reply-to']).slice(0, 8)}…)`
            : ''
          const needReply = m.metadata?.['x-aw-require-reply'] === 'true'
            ? ` [需回复:用 send_message_to_agent 回 ${from},in_reply_to=${m.messageId}]`
            : ''
          const body = m.parts.map(p => 'text' in p ? p.text : '').join(' ')
          return `  [${i + 1}/${msgs.length}] [from ${from}]${needReply}${reply} ${body.slice(0, 2000)}`
        }).join('\n')
        return {
          text:
            `未消费消息(${msgs.length},已读即取):\n${text}`
            + (msgs.length > 1
              ? '\n(收到多条:请按编号逐条处理并逐条回复,不要只回应最后一条或合并敷衍)'
              : ''),
        }
      }

      case 'read_channel_mail': {
        const limit = (args.limit as number | undefined) ?? 50
        const agentId = args.agent_id as string | undefined
        const mails = await ws.listMail({ limit, agentId })
        if (mails.length === 0) return { text: 'Channel 无邮件记录(或该成员无往来)' }
        const text = mails.map((m) => {
          const from = m.fromAgentId ?? '(系统)'
          const to = m.toAgentId ?? '(广播)'
          const body = partsToText(m.parts).trim().slice(0, 2000)
          const reply = m.metadata?.['x-aw-in-reply-to']
            ? ` [回复 ${String(m.metadata['x-aw-in-reply-to']).slice(0, 8)}…]`
            : ''
          const label = m.metadata?.['x-aw-task-kind'] === 'assign'
            ? '[任务指派]'
            : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? '[实时]' : '[协作]'
          const state = m.state === 'pending' ? '未读' : m.state === 'consuming' ? '处理中' : '已读'
          return `  ${m.createdAt.slice(11, 19)} ${label} ${from} → ${to} (${state})${reply}: ${body || '(空)'}`
        }).join('\n')
        return { text: `Channel 邮件(${mails.length},倒序;可传 agent_id 查看指定成员信箱):\n${text}` }
      }

      case 'broadcast_message': {
        const message = args.message as string
        const priority = (args.priority as string | undefined) ?? 'task'
        const agents = await ws.listAgents()
        const others = agents.filter(a => a.id !== identity.agentId)
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
            `我的任务队列(${identity.role}):`,
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
          `  ${s.agentId} (${s.name}, role=${s.role}, state=${s.state}, current=${s.currentTaskId ?? '-'}${s.currentTaskTitle ? `「${s.currentTaskTitle}」` : ''}, progress=${s.currentTaskProgress ?? '-'}%, queued=${s.queuedCount}, completed=${s.completedCount})`,
        )
        return { text: `团队队列总览(${overview.length}):\n${lines.join('\n') || '(空)'}` }
      }

      case 'reassign_task': {
        const taskId = args.task_id as string
        const toAgentId = args.to_agent_id as string
        const task = await ws.reassignTask(taskId, toAgentId)
        return { text: `任务 ${taskId}("${task.title}")已调配 → ${toAgentId}(state=${task.state})` }
      }

      case 'update_task': {
        const taskId = args.task_id as string
        const title = args.title as string | undefined
        const description = args.description as string | undefined
        const task = await ws.updateTask(taskId, { title, description })
        return { text: `任务 ${taskId} 已更新: "${task.title}"` }
      }

      case 'cancel_task': {
        const taskId = args.task_id as string
        // 守卫:goal/loop/pipeline 的 mode 父任务是用户的作业主任务,Agent 不得经工具取消
        const target = await ws.getTask(taskId).catch(() => null)
        if (target && extractTaskMode(target)) {
          return {
            text: `拒绝:任务 ${taskId} 是 mode 父任务(${target.title}),不能用 cancel_task 取消。若目标未达成 → dispatch_task 派发子任务补齐差距;若确认无法达成 → complete_task 并在交付中说明未达成原因。终止整个作业请由用户操作。`,
          }
        }
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
        const taskId = args.task_id as string
        const task: WorkspaceTask = await ws.getTask(taskId)
        const artifactText = task.artifacts.map(a =>
          `  artifact ${a.artifactId}: ${a.parts.map(p => 'text' in p ? p.text.slice(0, 100) : '').join('; ')}`,
        ).join('\n')
        return {
          text: `任务 ${task.id}\n  状态: ${task.state}\n  标题: ${task.title}\n  描述: ${task.description ?? '-'}\n  指派: ${task.assigneeId}\n  进度: ${task.progress}%\n  成果:\n${artifactText || '  (无)'}`,
        }
      }

      case 'search_memory': {
        const query = args.query as string
        const scope = (args.scope as 'auto' | 'private' | 'shared' | undefined) ?? 'auto'
        const snippets = await ws.recallMemory({ query, scope, limit: args.limit as number | undefined })
        if (snippets.length === 0) {
          return { text: `记忆检索无命中(query="${query}", scope=${scope})。可尝试更换关键词或放宽 scope。` }
        }
        const lines = snippets.map(s =>
          `  [${s.source}·${s.kind}·score=${s.score}] ${s.title}\n    ${s.content}`,
        )
        return { text: `记忆检索结果(${snippets.length} 条, scope=${scope}):\n${lines.join('\n')}` }
      }

      case 'save_memory': {
        const title = args.title as string
        const content = args.content as string
        const scope = args.scope as 'private' | 'shared'
        const saved = await ws.saveMemory({
          title,
          content,
          importance: args.importance as number | undefined,
          scope,
          dedupKey: args.dedup_key as string | undefined,
        })
        const where = scope === 'shared' ? 'Channel 公共记忆(全员可检索)' : '本人私有记忆'
        return { text: `已沉淀到${where}: "${title}"(dedupKey=${saved.dedupKey})` }
      }

      case 'create_team_agent': {
        const name = args.name as string
        const harness = args.harness as string | undefined
        const systemPrompt = args.system_prompt as string | undefined
        const reason = args.reason as string | undefined
        const agent: AgentInfo = await ws.createTeamMember({
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
        const agentId = args.agent_id as string
        const name = args.name as string | undefined
        const systemPrompt = args.system_prompt as string | undefined
        const enabled = args.enabled as boolean | undefined
        const reason = args.reason as string | undefined
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
        const agentId = args.agent_id as string
        const reason = args.reason as string | undefined
        const result = await ws.removeTeamMember(agentId, reason)
        const recycleNote = result.recycledTasks.length > 0
          ? `其 ${result.recycledTasks.length} 个在途任务已回收(排队任务重派给剩余最短队列成员;执行中任务转 FAILED 待调度重试)。`
          : `该成员无在途任务。`
        return { text: `团队成员 ${agentId} 已移除。${recycleNote}` }
      }

      case 'my_industrial_nodes': {
        return toolMyIndustrialNodes(identity.agentId)
      }
      case 'dcw_control': {
        return toolDcwControl(identity.agentId, args as { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string })
      }
      case 'dcw_read': {
        return toolDcwRead(identity.agentId, args as { node_id?: string })
      }
      case 'daq_query': {
        return toolDaqQuery(identity.agentId, args as Parameters<typeof toolDaqQuery>[1])
      }
      case 'daq_frames': {
        return toolDaqFrames(identity.agentId, args as Parameters<typeof toolDaqFrames>[1])
      }
      case 'dcw_judge': {
        return toolDcwJudge(identity.agentId, args as { record_id?: string, verdict?: string, reason?: string })
      }
      case 'dcw_rollback': {
        return toolDcwRollback(identity.agentId, args as { record_id?: string, node_id?: string, to?: string })
      }
      case 'dcw_journal': {
        return toolDcwJournal(identity.agentId, args as { node_id?: string, recipe_id?: string, limit?: number | string })
      }
    }
    return { text: `未知工具: ${req.toolName}`, isError: true }
  }
  catch (err) {
    return {
      text: `工具执行异常(${req.toolName}): ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}
