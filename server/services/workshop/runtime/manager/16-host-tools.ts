/**
 * ManagerHostTools —— 宿主工具调用入口与信箱面
 * (分层 17/19,承 ManagerA2A)
 */
import { ManagerA2A } from './15-a2a'
import type { A2AMessage, ChannelMail } from '../../types/a2a'
import type { AgentInfo } from '../../agents/agent-interface'
import { AppError } from '../../../../utils/errors'
import { checkToolAgainstScope } from '../permission-scope'
import { getChannelPluginsRepo } from '../../db/channel-plugins.repo'
import { hostToolsForRole } from '../../agents/host-tool-bridge'
import { instanceToAgentInfo, rowToChannelMail } from './helpers'
import { listPluginTools, pluginOfTool } from '../../agents/plugin-tools'
import { rowToMessage } from '../mailbox'

export abstract class ManagerHostTools extends ManagerA2A {
  /**
   * 工具桥(协作工具族):按 agentId 定位 channel 并调用其 workspace 方法。
   * 与工业工具桥同一服务层,供 REST 直调(测试/运维/控制台)。
   */
  async invokeAgentWorkspaceTool(agentId: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string, isError?: boolean }> {
    const row = this.deps.repos.channelAgents.findById(agentId)
    if (!row || row.enabled !== 1) throw new AppError(404, 'NOT_FOUND', `agent 不存在或已停用: ${agentId}`)
    const ws = this.ensureAgentRuntime(row.channelId, agentId)?.workspace
    if (!ws) throw new AppError(400, 'AGENT_NOT_READY', `agent 运行时未装配: ${agentId}`)
    switch (tool) {
      case 'list_other_teams': {
        const teams = ws.listOtherTeams()
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
        const query = String(args.query ?? '')
        if (!query) return { text: '缺少 query', isError: true }
        const rows = ws.searchOtherTeamsMemory({ query, limit: Number(args.limit ?? 5) })
        if (rows.length === 0) return { text: `其他团队的共享记忆中没有命中「${query}」的内容。` }
        const text = rows.map((r) => {
          const provenance = [
            `[${r.channelName}]`,
            r.createdAt.slice(0, 10),
            r.visibility ?? 'cross-channel',
            r.taskId ? `task=${r.taskId.slice(0, 8)}` : '',
            r.rootId ? `root=${r.rootId.slice(0, 8)}` : '',
          ].filter(Boolean).join(' · ')
          return `- ${provenance} 「${r.title}」: ${r.content}`
        }).join('\n')
        return { text: `其他团队共享记忆命中 ${rows.length} 条:\n${text}` }
      }
      case 'send_cross_channel_message': {
        if (!args.to_channel_id || !args.message) return { text: '缺少 to_channel_id 或 message', isError: true }
        const r = await ws.sendCrossChannelMessage({
          toChannelId: String(args.to_channel_id),
          parts: [{ text: String(args.message) }],
          requireReply: args.require_reply === true,
          inReplyTo: typeof args.in_reply_to === 'string' ? args.in_reply_to : undefined,
        })
        return { text: `跨 Channel 消息已送达「${r.toChannelName}」的 Leader(channel=${r.toChannelId}, lead=${r.toLeadAgentId.slice(0, 8)}),消息 id=${r.messageId.slice(0, 8)}。` }
      }
      default:
        throw new AppError(400, 'BAD_REQUEST', `工具桥不支持该协作工具: ${tool}`)
    }
  }

  /**
   * harness 无关全量工具直调(agent token 鉴权;stdio MCP 桥回程的唯一入口)。
   * 插件工具最先(与 host-tool-bridge 同源过滤,不依赖引擎运行时 —— mock 等无引擎
   * 工具面的成员经 REST invoke 同样可用);其余 impl.dispatchHostTool 优先,未实现
   * 回退协作工具族。
   */
  async invokeHostTool(input: { agentId: string, token?: string, tool: string, args?: Record<string, unknown> }): Promise<{ text: string, isError?: boolean }> {
    const row = this.deps.repos.channelAgents.findById(input.agentId)
    if (!row || row.enabled !== 1) throw new AppError(404, 'NOT_FOUND', `agent 不存在或已停用: ${input.agentId}`)
    // token 鉴权(MCP 桥路径必带;缺省视为服务端内部调用,走 REST 已有用户鉴权)
    if (input.token !== undefined && input.token !== row.token) {
      throw new AppError(401, 'UNAUTHORIZED', 'agent token 校验失败')
    }
    // ── 人类权限作用域判定(§13.3)────────────────────────────────────────────
    // 该 Agent 若正在服务一次**群成员**发起的人类调用,则管理面/高危工具一律拒绝:
    // @Agent 不等于把 owner 权限委托给成员,发起者权限不得因 Agent 身份更高而放大。
    // 无作用域(系统/agent 自发调用)→ 放行,沿用既有授权(MCP token / REST 用户鉴权)。
    {
      const scope = this.activeInvocationScopes.get(input.agentId)
      const verdict = checkToolAgainstScope(scope, input.tool)
      if (!verdict.allowed) throw new AppError(403, verdict.reason, verdict.message)
    }
    // 工具执行错误(业务约束/目标不存在等)一律降级为 isError 文本——
    // 绝不让 AppError 以 unhandledRejection 逃逸拖垮 worker(stability-guard 会因此退出整进程)
    try {
      // 活性登记:调度器停滞看门狗以「最近工具调用」为健康信号(见 SchedulerLoopOptions.toolActivityOf)
      this.lastToolInvokeAt.set(input.agentId, Date.now())
      // 插件工具:团队开关过滤 + handler 直调(ctx.omp 注册的自定义工具全 harness 同源)
      const pluginTool = listPluginTools().get(input.tool)
      if (pluginTool) {
        const channelOff = getChannelPluginsRepo().explicitFor(row.channelId)
        const owner = pluginOfTool(input.tool)
        if (channelOff && owner && channelOff.get(owner) === false) {
          return {
            text: `该团队未启用插件「${owner}」,${input.tool} 不可用。可在团队设置→插件中开启。`,
            isError: true,
          }
        }
        const identity = {
          agentId: row.id,
          channelId: row.channelId,
          role: (row.role === 'lead' ? 'lead' : 'worker') as 'lead' | 'worker',
          name: row.name,
        }
        return await pluginTool.handler(input.args ?? {}, identity)
      }
      const runtime = this.ensureAgentRuntime(row.channelId, input.agentId)
      if (runtime) {
        const viaImpl = await runtime.dispatchHostTool(input.tool, input.args ?? {})
        if (viaImpl) return viaImpl
      }
      // 回退:impl 未实现工具面(如 mock)→ 协作工具族直调
      return await this.invokeAgentWorkspaceTool(input.agentId, input.tool, input.args ?? {})
    }
    catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { text: `工具「${input.tool}」调用失败: ${reason}`, isError: true }
    }
  }

  /** 按 token 解析 agent(桥侧只需 token 的自证路径;未命中返回 null) */
  resolveAgentByToken(token: string): { agentId: string, channelId: string } | null {
    if (!token) return null
    const row = this.deps.repos.channelAgents.findByToken(token)
    if (!row || row.enabled !== 1) return null
    return { agentId: row.id, channelId: row.channelId }
  }

  /** 工具面 schema(MCP 桥 tools/list):按 agent 角色装配,与 omp 注入面同源 */
  hostToolDefsFor(agentId: string): Array<{ name: string, label?: string, description: string, parameters: Record<string, unknown> }> {
    const row = this.deps.repos.channelAgents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `agent 不存在: ${agentId}`)
    return hostToolsForRole(row.role === 'lead' ? 'lead' : 'worker', row.channelId)
  }

  /**
   * HITL 应答传导(codex/opencode/dsh 审批;omp-dialog 走 terminal 通道不经此)。
   * 找不到运行时或 impl 未实现 → 409(条目不可应答)。
   *
   * ⚠️ **internal-only**:本方法**不做**审批策略校验,也**不做**原子抢占 ——
   * 它只是"把已裁决的 outcome 传导给适配器"。所有对外入口(hitl/respond、
   * agent-tools/approvals/decide)必须经 `hitl-decision.decideHitlRequest()`,
   * 由它完成 requireCanApprove + claimPending(并发只有一个成功、其余 409)后再调本方法。
   * 内部/脚本直呼会绕过抢占闸门,仅限测试脚手架使用。
   */
  async respondHarnessHitl(agentId: string, kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void> {
    const row = this.deps.repos.channelAgents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `agent 不存在: ${agentId}`)
    const runtime = this.ensureAgentRuntime(row.channelId, agentId)
    if (!runtime) throw new AppError(409, 'NOT_RESPONDABLE', 'agent 运行时未装配,无法应答')
    const ok = await runtime.respondHitl(kind, id, outcome)
    if (!ok) throw new AppError(409, 'NOT_RESPONDABLE', '该 harness 不支持程序化应答')
  }

  /** 阻塞长轮询(poll_messages):到信即时唤醒,250ms 兜底重查 */
  async waitMailbox(channelId: string, callerAgentId: string, limit: number, waitMs: number): Promise<A2AMessage[]> {
    this.requireMember(channelId, callerAgentId)
    const runtime = this.ensureAgentRuntime(channelId, callerAgentId)
    if (runtime) return runtime.waitPending(limit, waitMs)
    // 运行时未装配(极端时序):退化为一次性快照查询
    return this.pollMailbox(channelId, callerAgentId, limit)
  }

  async pollMailbox(channelId: string, callerAgentId: string, limit = 100): Promise<A2AMessage[]> {
    this.requireMember(channelId, callerAgentId)
    return this.deps.repos.messages
      .listPendingByChannelAgent(channelId, callerAgentId)
      .slice(0, limit)
      .map(rowToMessage)
  }

  /** 确认消费自己 mailbox 的协作消息(读即取;id 须属于 caller 的 pending 集) */
  ackMailbox(channelId: string, callerAgentId: string, messageIds: string[]): void {
    this.requireMember(channelId, callerAgentId)
    const pending = new Set(
      this.deps.repos.messages
        .listPendingByChannelAgent(channelId, callerAgentId)
        .map(r => r.id),
    )
    for (const id of messageIds) {
      // claim 守卫:与 steer 注入原子竞争(peek 与 ack 之间消息可能被认领),
      // 认领成功才标记消费——失败说明 steer 已注入运行中会话,不再重复投递
      if (pending.has(id) && this.deps.repos.messages.claim(id)) {
        this.deps.repos.messages.markConsumed(id)
      }
    }
  }

  /**
   * (仅 lead)Channel 邮件全览:全部 agent 间消息(含已消费/任务投递),按时间倒序。
   * lead 调度观察面——worker 间的点对点通信(含结果回执)对 lead 可见,
   * 供派发前判断"该结果是否已由某 worker 经 mail 产出",避免重复派发浪费资源。
   * 可选 agentId 过滤参与方(from 或 to)。
   */
  async listChannelMail(
    channelId: string,
    callerAgentId: string,
    opts: { limit?: number, agentId?: string } = {},
  ): Promise<ChannelMail[]> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可查看 Channel 全部邮件')
    }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200))
    const mails = this.deps.repos.messages
      .listRecentByChannel(channelId, limit)
      .map(rowToChannelMail)
    if (opts.agentId) {
      return mails.filter(m => m.fromAgentId === opts.agentId || m.toAgentId === opts.agentId)
    }
    return mails
  }

  async subscribe(channelId: string, callerAgentId: string, input: { agentIds?: string[] }): Promise<void> {
    this.requireMember(channelId, callerAgentId)
    for (const targetId of input.agentIds ?? []) {
      const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, targetId)
      if (!target) {
        throw new AppError(403, 'SCOPE_VIOLATION', `目标 Agent ${targetId} 不在本 channel`)
      }
      this.deps.repos.subscriptions.add(channelId, callerAgentId, targetId)
    }
  }

  /** 实例级 token → 实例视图(AgentInfo) */
  findByToken(token: string): AgentInfo | undefined {
    const m = this.deps.repos.channelAgents.findByToken(token)
    return m ? instanceToAgentInfo(m) : undefined
  }
}
