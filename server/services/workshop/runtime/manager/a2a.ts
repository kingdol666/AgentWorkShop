/**
 * ManagerA2A —— Agent 间消息与跨 Channel 协作
 * (拆分层,承 ManagerTasks)
 */
import { ManagerTasks } from './tasks'
import type { A2AMessage, Part } from '../../types/a2a'
import type { ChannelRow } from '../../db/database'
import { AppError } from '../../../../utils/errors'
import { WORKSHOP_PERMISSION_SCOPE_HEADER, intersectWorkshopPermissionScope, parseWorkshopPermissionScope } from '../../../../../shared/workshop-protocol'
import { buildMessage } from './helpers'
import { segmentCJK, unsegmentCJK } from '../memory'

export abstract class ManagerA2A extends ManagerTasks {
  async sendA2A(
    channelId: string,
    callerAgentId: string,
    input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> },
  ): Promise<A2AMessage> {
    this.requireMember(channelId, callerAgentId)
    // 容错寻址:id/模板 id/名字/唯一前缀;失败错误携带当前名册(LLM 自我纠正)
    const target = this.resolveMemberRef(channelId, input.toAgentId)
    // ── 委派链传播(§13.3「子任务和 Agent 间委派必须传播 permissionScope」)─────────
    // 调用者若正在服务一次人类发起的调用,其委派必须继承**同一个**(并只收紧)作用域:
    // 否则普通成员 @Agent 后,该 Agent 再委派给兄弟 Agent,被委派者就变回"无人类上下文",
    // 等于用一次委派把成员权限洗成系统权限。
    const callerScope = this.activeInvocationScopes.get(callerAgentId) ?? null
    const inbound = parseWorkshopPermissionScope(input.metadata?.[WORKSHOP_PERMISSION_SCOPE_HEADER])
    const delegatedScope = callerScope
      ? intersectWorkshopPermissionScope(callerScope, inbound)
      : inbound
    const message = buildMessage(channelId, 'ROLE_AGENT', input.parts, {
      ...(input.metadata ?? {}),
      ...(delegatedScope
        ? { [WORKSHOP_PERMISSION_SCOPE_HEADER]: JSON.stringify(delegatedScope) }
        : {}),
      'x-aw-target-agent': target.id,
      'x-aw-from-agent': callerAgentId,
    })
    if (delegatedScope) this.activeInvocationScopes.set(target.id, delegatedScope)
    // 真送达契约:route 回执必须包含目标(落库 enqueue 同步完成),否则向上抛错 ——
    // 消息绝不允许"报告已发送"却没进对方信箱
    const delivered = this.route(channelId, message)
    if (!delivered.includes(target.id)) {
      throw new AppError(502, 'DELIVERY_FAILED', `消息未能投递到 ${target.name} 的信箱(成员装配失败),请重试或改投其他成员`)
    }
    return message
  }

  /**
   * 按主键查 Channel 成员实例(跨频道)。
   * 用途:校验「Agent ↔ 工业节点绑定」的主体 —— 运行时持绑定做鉴权的是**成员实例**,
   * 不是 Agent 模板;绑到模板 id 上会得到一条永远不生效的静默绑定(实测踩过)。
   */
  findChannelAgentById(channelAgentId: string): { id: string, channelId: string, templateId: string | null } | undefined {
    const row = this.deps.repos.channelAgents.findById(channelAgentId)
    return row ? { id: row.id, channelId: row.channelId, templateId: row.templateId } : undefined
  }

  /** 某 Agent 模板已部署到哪些频道(用于把"绑错主体"的报错变成可执行提示) */
  listChannelAgentInstances(templateId: string): Array<{ id: string, channelId: string, name: string }> {
    return this.deps.repos.channelAgents.listByTemplate(templateId).map(r => ({
      id: r.id,
      channelId: r.channelId,
      name: this.deps.repos.channels.findById(r.channelId)?.name ?? r.channelId,
    }))
  }

  /**
   * 实时消息(外部/系统注入):priority=immediate → busy 时 steer 注入运行中的 omp 会话。
   * 触发器 requireReply=true → 接收方须回执(执行结果+所需内容,in_reply_to 关联)。
   */
  async sendImmediateMessage(input: {
    channelId: string
    fromAgentId?: string
    toAgentId: string
    parts: Part[]
    requireReply?: boolean
    /** 人类发送者显示名(REST 注入时的时间线归属;进入 x-aw-from-label 元数据) */
    fromLabel?: string
  }): Promise<A2AMessage> {
    // 无主消息拦截:发送方必须可追溯(agent 成员或人类显示名),否则拒绝发送
    const hasFromAgent = !!input.fromAgentId && this.deps.repos.channelAgents.findByChannelAgent(input.channelId, input.fromAgentId) != null
    if (!hasFromAgent && !input.fromLabel) {
      throw new AppError(400, 'NO_SENDER', '消息缺少可追溯发送人(fromAgentId 须为本 channel 成员,或提供 fromLabel 人类显示名)')
    }
    const metadata: Record<string, unknown> = {
      'x-aw-target-agent': input.toAgentId,
      'x-aw-msg-priority': 'immediate',
    }
    if (hasFromAgent) metadata['x-aw-from-agent'] = input.fromAgentId
    if (input.fromLabel) metadata['x-aw-from-label'] = input.fromLabel
    if (input.requireReply) metadata['x-aw-require-reply'] = 'true'
    const message = buildMessage(input.channelId, 'ROLE_AGENT', input.parts, metadata)
    const delivered = this.route(input.channelId, message)
    if (!delivered.includes(input.toAgentId)) {
      throw new AppError(502, 'DELIVERY_FAILED', `消息未能投递到 ${input.toAgentId} 的信箱,请重试`)
    }
    return message
  }

  /**
   * 跨 Channel 点对点通信(仅 lead):把消息直投目标 channel 的 lead mailbox。
   * 沿用既有 mailbox/route 机制(投递/唤醒/消费/回执全复用),仅新增跨 channel 路由:
   *  - 权限:发送方必须是本 channel 启用成员中的 lead(worker/系统拒绝);
   *  - 同主约束:两个 channel 必须属于同一 owner(用户级隔离不破);
   *  - 守卫通行:x-aw-cross-channel 标记由服务端在发送时盖章(REST/工具入参不可伪造),
   *    目标 channel 信箱守卫据此放行非成员发送方的跨 channel 消息;
   *  - 回执:目标 lead 经同一机制回信(其 send_message_to_agent / 本方法均可,
   *    in_reply_to 关联触发实时推送)。
   */
  async sendCrossChannelMessage(
    fromChannelId: string,
    fromAgentId: string,
    input: { toChannelId: string, parts: Part[], requireReply?: boolean, inReplyTo?: string },
  ): Promise<{ messageId: string, toChannelId: string, toChannelName: string, toLeadAgentId: string }> {
    // 权限闸:发送方 = 本 channel 启用成员中的 lead
    const sender = this.deps.repos.channelAgents.findByChannelAgent(fromChannelId, fromAgentId)
    if (!sender || sender.enabled !== 1) {
      throw new AppError(403, 'SCOPE_VIOLATION', '跨 Channel 通信的发送方必须是本 channel 的启用成员')
    }
    if (sender.role !== 'lead') {
      throw new AppError(403, 'ROLE_FORBIDDEN', `跨 Channel 通信仅限 Leader 发起(${sender.name} 是 ${sender.role})`)
    }

    // 目标 channel 解析(id 精确 > 名字精确 > 名字唯一包含);禁自指/禁停用/须有 lead
    const needle = input.toChannelId.trim().toLowerCase()
    const rows = this.deps.repos.channels.list()
    const target = rows.find(c => c.id === input.toChannelId)
      ?? rows.find(c => c.name.toLowerCase() === needle)
      ?? (() => {
        const partial = rows.filter(c => c.name.toLowerCase().includes(needle))
        return partial.length === 1 ? partial[0] : undefined
      })()
    if (!target || target.id === fromChannelId) {
      throw new AppError(404, 'CHANNEL_NOT_FOUND', `目标 channel 未命中(且不可为本 channel): ${input.toChannelId}`)
    }
    if (target.enabled !== 1) throw new AppError(400, 'CHANNEL_DISABLED', `目标 channel 已停用: ${target.name}`)
    if (!target.leadAgentId) throw new AppError(400, 'NO_LEAD', `目标 channel 没有 lead,无法接收跨 Channel 消息: ${target.name}`)

    // 同主约束:跨团队协作不越用户边界
    const sourceChannel = this.deps.repos.channels.findById(fromChannelId)
    if (sourceChannel && target.ownerUserId !== null && sourceChannel.ownerUserId !== null
      && sourceChannel.ownerUserId !== target.ownerUserId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '跨 Channel 通信仅限同一用户的 channel 之间')
    }

    // 目标 lead 必须是目标 channel 的启用成员(防悬空 leadAgentId)
    const targetLead = this.deps.repos.channelAgents.findByChannelAgent(target.id, target.leadAgentId)
    if (!targetLead || targetLead.enabled !== 1) {
      throw new AppError(400, 'NO_LEAD', `目标 channel 的 lead 成员缺失或已停用: ${target.name}`)
    }

    const message = buildMessage(target.id, 'ROLE_AGENT', input.parts, {
      'x-aw-target-agent': targetLead.id,
      'x-aw-from-agent': fromAgentId,
      'x-aw-from-channel': fromChannelId,
      'x-aw-cross-channel': 'true',
      'x-aw-from-label': `跨Channel:${sourceChannel?.name ?? fromChannelId} / ${sender.name}`,
      ...(input.requireReply ? { 'x-aw-require-reply': 'true' } : {}),
      // in_reply_to 关联:channel-runtime 将其视为 realtime,回复即时推送对端
      ...(input.inReplyTo ? { 'x-aw-in-reply-to': input.inReplyTo } : {}),
    })
    const delivered = this.route(target.id, message)
    if (!delivered.includes(targetLead.id)) {
      throw new AppError(502, 'DELIVERY_FAILED', `跨 Channel 消息未能投递到「${target.name}」的 lead 信箱,请重试`)
    }
    return {
      messageId: message.messageId,
      toChannelId: target.id,
      toChannelName: target.name,
      toLeadAgentId: targetLead.id,
    }
  }

  /**
   * 跨团队可见性(仅 lead):其他 channel 的场景任务概览(同主、启用)。
   * 协同工作流的第一步——先看别的团队在做什么/做过什么,再决定是否发信请求协作。
   */
  listOtherTeamsOverview(channelId: string, agentId: string): Array<{
    channelId: string
    name: string
    description: string
    leadName: string | null
    /** 团队共享域知识量(实现体第 2661 行已产出;原声明漏写 → 与 AgentWorkspace.listOtherTeams 漂移) */
    sharedMemories: number
    activeTasks: Array<{ id: string, title: string, state: string }>
    recentCompleted: Array<{ title: string }>
  }> {
    this.requireMember(channelId, agentId)
    const sender = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!sender || sender.role !== 'lead') {
      throw new AppError(403, 'ROLE_FORBIDDEN', `团队任务概览仅限 Leader(${sender?.name ?? agentId} 是 ${sender?.role ?? '非成员'})`)
    }
    const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED'])
    return this.otherSameOwnerChannels(channelId).map((c) => {
      const tasks = this.deps.repos.tasks.listByChannel(c.id)
      const leadRow = c.leadAgentId ? this.deps.repos.channelAgents.findById(c.leadAgentId) : undefined
      return {
        channelId: c.id,
        name: c.name,
        description: c.description ?? '',
        leadName: leadRow?.name ?? null,
        /** 团队共享域知识量:>0 说明该队有可检索的作业结论(search_other_teams_memory) */
        sharedMemories: this.deps.repos.memories.countTeamShared(c.id),
        activeTasks: tasks
          .filter(t => !terminal.has(t.state))
          .map(t => ({ id: t.id, title: t.title, state: t.state })),
        recentCompleted: tasks
          .filter(t => t.state === 'COMPLETED')
          .slice(0, 3)
          .map(t => ({ title: t.title })),
      }
    })
  }

  /**
   * 跨 Channel 共享记忆检索(**仅 Leader**,只读):其他 channel 的 __team__ 公共域。
   * §7.4 访问策略:其他 Channel 只允许 Leader 查询,且**仍受同一 owner/组织范围限制**。
   */
  recallOtherTeamsMemory(channelId: string, agentId: string, input: { query: string, limit?: number }): Array<{
    channelId: string
    channelName: string
    title: string
    content: string
    importance: number
    createdAt: string
    /** §7.4 DTO 必带来源定位:root/task/可见性 */
    taskId: string | null
    rootId: string | null
    visibility: MemoryVisibility
  }> {
    this.requireMember(channelId, agentId)
    const sender = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!sender || sender.role !== 'lead') {
      throw new AppError(403, 'ROLE_FORBIDDEN', '跨 Channel 共享记忆仅限 Leader 查询')
    }
    const q = input.query.trim()
    if (!q) return []
    const others = this.otherSameOwnerChannels(channelId)
    if (others.length === 0) return []
    const matchQuery = segmentCJK(q).split(/\s+/).filter(Boolean).join(' OR ')
    const rows = this.deps.repos.memories.searchTeamSharedAcross(
      matchQuery,
      others.map(c => c.id),
      Math.min(Math.max(input.limit ?? 5, 1), 20),
    )
    // 触摸命中行(access_count/last_accessed_at):与 recallRows 同信号,强化后续召回排序
    for (const r of rows) this.deps.repos.memories.touch(r.id)
    return rows.map(r => ({
      channelId: r.channelId,
      channelName: others.find(c => c.id === r.channelId)?.name ?? r.channelId,
      title: r.title,
      content: unsegmentCJK(r.content).slice(0, 400),
      importance: r.importance,
      createdAt: r.createdAt,
      taskId: r.taskId ?? null,
      rootId: r.taskId ? (this.deps.repos.tasks.findById(r.taskId)?.parentId ?? r.taskId) : null,
      visibility: 'cross-channel' as MemoryVisibility,
    }))
  }

  /**
   * 同主且启用的其他 channel 列表(跨团队可见性的作用域)。
   *
   * §7.4 修复:旧判据 `self.owner == null || c.owner == null || c.owner === self.owner`
   * 中**任一 NULL owner 即放行** —— 遗留无主 channel(owner NULL)因此能被任意
   * channel 的 Lead 读到,越出「同一 owner/组织」范围。现在收紧为:
   * 双方 owner 都必须非空且相等;无主(遗留/公共)channel 不参与跨团队检索。
   */
  protected otherSameOwnerChannels(channelId: string): ChannelRow[] {
    const self = this.deps.repos.channels.findById(channelId)
    const owner = self?.ownerUserId ?? null
    if (!owner) return []
    return this.deps.repos.channels.list().filter(c =>
      c.id !== channelId
      && c.enabled === 1
      && c.ownerUserId != null
      && c.ownerUserId === owner)
  }
}

/** 记忆可见性标注(§7.4;DTO 必须自描述来源域) */
export type MemoryVisibility = 'channel-shared' | 'private' | 'cross-channel'
