/**
 * ManagerChat —— 群聊事实层:消息落库、投递、@ 解析、快照投影
 * (拆分层,承 ManagerAccess)
 */
import { ManagerAccess } from './access'
import type { ActingUser } from './types'
import type { ChatDeliveryRow, ChatMessageRow } from '../../db/database'
import type { ChatMention } from '../../db/chat-message.repo'
import type { ChatMessageDto } from '../chat-projection'
import type { MentionableAgent, MentionableUser } from '../chat-mention'
import type { WorkshopPermissionScope } from '../../../../../shared/workshop-protocol'
import { AppError } from '../../../../utils/errors'
import { WORKSHOP_PERMISSION_SCOPE_HEADER, parseWorkshopPermissionScope } from '../../../../../shared/workshop-protocol'
import { agentMentions, resolveMentions, userMentions } from '../chat-mention'
import { buildMessage, resolveOwnerName } from './helpers'
import { parseJson } from '../../db/database'
import { projectChatMessage, projectChatSnapshot } from '../chat-projection'
import { withTransaction } from '../../db/transaction'

export abstract class ManagerChat extends ManagerAccess {
  /**
   * SQLite 事务包裹(可重入;失败一律回滚)。
   *
   * 实现委托给 `db/transaction.ts` —— 那里统一处理"SQLite 不支持嵌套 BEGIN"的问题
   * (嵌套调用降级为 SAVEPOINT),并对外暴露 `isTransactionOpen()` 供 WS 落库缓冲
   * 判断"是否该推迟写入"(同连接的非事务写入会被并入当前事务,回滚会连带丢弃)。
   *
   * 契约:事务体内**只做同步写**(不要 await / LLM / 子进程 / 网络)。
   */
  protected inTransaction<T>(fn: () => T): T {
    return withTransaction(this.deps.db, fn)
  }

  /** 可被 @ 的 Agent 候选(本 channel 启用成员) */
  protected mentionableAgents(channelId: string): MentionableAgent[] {
    return this.deps.repos.channelAgents.listByChannel(channelId).map(m => ({
      id: m.id,
      name: m.name,
      role: m.role,
      enabled: m.enabled,
    }))
  }

  /** 可被 @ 的人类候选:active 成员 ∪ owner(owner 即使成员行缺失也算) */
  protected mentionableUsers(channelId: string): MentionableUser[] {
    const channel = this.deps.repos.channels.findById(channelId)
    const out = new Map<string, MentionableUser>()
    for (const m of this.channelMemberRepo.listActiveByChannel(channelId)) {
      out.set(m.userId, { id: m.userId, name: resolveOwnerName(m.userId) ?? m.userId.slice(0, 8) })
    }
    if (channel?.ownerUserId && !out.has(channel.ownerUserId)) {
      out.set(channel.ownerUserId, { id: channel.ownerUserId, name: resolveOwnerName(channel.ownerUserId) ?? channel.ownerUserId.slice(0, 8) })
    }
    return [...out.values()]
  }

  /** 用户展示名解析(60s 缓存;失败回落 id 前缀) */
  protected displayNameOf(userId: string): string {
    return resolveOwnerName(userId) ?? userId.slice(0, 8)
  }

  /** 群聊历史(投影;分页 cursor = beforeId) */
  listChatMessages(channelId: string, user: ActingUser, opts: { before?: string, limit?: number } = {}): ChatMessageDto[] {
    this.requireChannelMember(channelId, user)
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    return this.chatMessageRepo.listBefore(channelId, opts.before, limit).map(projectChatMessage)
  }

  /** 增量拉取(游标 = ISO 时刻;上限 200) */
  listChatMessagesSince(channelId: string, user: ActingUser, afterIso: string, limit = 200): ChatMessageDto[] {
    this.requireChannelMember(channelId, user)
    return this.chatMessageRepo.listSince(channelId, afterIso, limit).map(projectChatMessage)
  }

  /** 群聊快照(投影;非管理者不带管理面 agents) */
  chatSnapshotOf(channelId: string, user: ActingUser): ReturnType<typeof projectChatSnapshot> {
    const channel = this.requireChannelMember(channelId, user)
    const perms = this.channelPermissionsOf(channelId, user)
    const members = this.channelMemberRepo.listByChannel(channelId)
    return projectChatSnapshot({
      channel,
      members,
      messages: this.chatMessageRepo.listRecent(channelId, 50),
      displayNameOf: id => this.displayNameOf(id),
      manageAgents: perms.canManage
        ? this.deps.repos.channelAgents.listByChannel(channelId)
        : null,
      agentStates: Object.fromEntries(
        [...this.agentIndex.values()]
          .filter(rt => rt.channelId === channelId)
          .map(rt => [rt.agentId, rt.getState()]),
      ) as Record<string, 'idle' | 'busy' | 'stopped'>,
    })
  }

  /**
   * 解析群聊发送目标(mention 权威解析 + 引用校验)。
   *
   * 单独成函数的原因:这是**权限与归属的判定点**(谁会被 @ 到、引用是否越频道),
   * 与落库/发布无关。`sendChatMessage` 里原先把这段和事务、发布、投递混在 146 行里,
   * 审阅"目标是否可能被伪造"时要在长函数中翻找。
   */
  protected resolveChatTargets(
    channelId: string,
    text: string,
    input: { mentions?: ChatMention[], replyToId?: string | null },
  ): { resolved: ReturnType<typeof resolveMentions>, replyToId: string | null } {
    // 解析 mention(服务端权威;客户端 mentions 仅作意图提示并逐个校验归属)
    const agents = this.mentionableAgents(channelId)
    const users = this.mentionableUsers(channelId)
    const agentIds = new Set(agents.map(a => a.id))
    const userIds = new Set(users.map(u => u.id))
    const resolved = resolveMentions({
      text,
      agents,
      users,
      explicit: input.mentions ?? [],
      validateExplicit: (m) => {
        if (m.type === 'agent') return agentIds.has(m.id) ? null : `agent 不属于本 Channel: ${m.id}`
        return userIds.has(m.id) ? null : `user 不是本 Channel 成员: ${m.id}`
      },
    })
    // replyToId 归属校验:引用必须落在本 Channel(跨频道引用会泄漏别的群的消息)
    let replyToId: string | null = null
    if (input.replyToId) {
      const anchor = this.chatMessageRepo.findById(input.replyToId)
      if (!anchor || anchor.channelId !== channelId) {
        throw new AppError(400, 'BAD_REPLY_TARGET', 'replyToId 不属于本 Channel')
      }
      replyToId = anchor.id
    }
    return { resolved, replyToId }
  }

  /**
   * 幂等重放:同 clientMessageId 已存在时构造与首次完全一致的响应。
   * 不重新解析 mention(首次的权威结果已落库)、不重复投递、不重复通知。
   */
  protected replayChatMessage(existing: ChatMessageRow): {
    message: ChatMessageDto
    deliveries: Array<{ deliveryId: string, agentId: string, status: string }>
    duplicates: boolean
    unresolvedMentions: string[]
    mentions: ChatMention[]
  } {
    return {
      message: projectChatMessage(existing),
      deliveries: this.chatMessageRepo.listDeliveries(existing.id).map(d => ({
        deliveryId: d.id, agentId: d.targetAgentId, status: d.status,
      })),
      duplicates: true,
      unresolvedMentions: [],
      mentions: parseJson<ChatMention[]>(existing.mentionsJson, []),
    }
  }

  /**
   * 消息 + 投递台账 + @用户通知 + outbox 的**同事务落库**。
   *
   * 必须同一事务的理由:崩溃后不允许出现"有消息无投递"(Agent 永远收不到)
   * 或"有投递无消息"(回复无法回指群聊)。发布(WS 广播)刻意留在事务**之外** ——
   * 广播失败不回滚已落库的事实,由客户端游标补拉收敛。
   */
  protected persistChatMessage(input: {
    channelId: string
    channelName: string
    user: ActingUser
    text: string
    mentions: ChatMention[]
    replyToId: string | null
    clientMessageId?: string
    agentTargets: ChatMention[]
    userTargets: ChatMention[]
  }): { message: ChatMessageRow, deliveries: ChatDeliveryRow[] } {
    return this.inTransaction(() => {
      const created = this.chatMessageRepo.create({
        channelId: input.channelId,
        senderType: 'user',
        senderId: input.user.id,
        senderName: this.displayNameOf(input.user.id),
        text: input.text,
        mentions: input.mentions,
        replyToId: input.replyToId,
        requesterUserId: input.user.id,
        clientMessageId: input.clientMessageId,
      })
      const dels = input.agentTargets.map(m => this.chatMessageRepo.createDelivery({
        chatMessageId: created.row.id,
        channelId: input.channelId,
        targetAgentId: m.id,
        status: 'pending',
      }).row)
      // @用户 定向通知(不触发 Agent)
      for (const m of input.userTargets) {
        this.notificationRepo.create({
          recipientUserId: m.id,
          channelId: input.channelId,
          chatMessageId: created.row.id,
          eventId: `mention:${created.row.id}:${m.id}`,
          type: 'mention',
          title: `${this.displayNameOf(input.user.id)} 在「${input.channelName}」@了你`,
          body: input.text.slice(0, 200),
          payload: { channelId: input.channelId, chatMessageId: created.row.id, senderId: input.user.id, senderName: this.displayNameOf(input.user.id) },
        })
      }
      // outbox:待发布事件(与消息同事务登记)
      this.outboxRepo.enqueue({
        aggregateType: 'chat_message',
        aggregateId: created.row.id,
        eventType: 'chat.message',
        payload: { channelId: input.channelId, chatMessageId: created.row.id },
        eventId: `chat.message:${created.row.id}`,
      })
      for (const d of dels) {
        this.outboxRepo.enqueue({
          aggregateType: 'chat_delivery',
          aggregateId: d.id,
          eventType: 'chat.delivery.status',
          payload: { channelId: input.channelId, deliveryId: d.id, chatMessageId: created.row.id, targetAgentId: d.targetAgentId, status: d.status },
          // 确定性幂等键:发布后能被 publishChatEvent 按同一个 id 收敛为 published
          // (缺省键带 randomUUID,发布端无法回指,行会永久停留 pending → 表无界增长)
          eventId: `chat.delivery.status:${d.id}`,
        })
      }
      return { message: created.row, deliveries: dels }
    })
  }

  /**
   * 发送群聊消息(唯一入站口;主计划 §5/§7)。
   *
   * 流程(每步都是具名函数,便于单独审阅):
   *   ① requireChannelChatEnabled  守卫(成员 + 群聊已开启)
   *   ② resolveChatTargets         mention 权威解析 + 引用归属校验
   *   ③ replayChatMessage          幂等键命中 → 返回首次结果,不重复副作用
   *   ④ persistChatMessage         消息/投递/通知/outbox 同事务落库
   *   ⑤ 事务提交后发布 WS 事件(失败不回滚事实)
   *   ⑥ deliverChatToAgent         每个 @Agent 恰好一条 mailbox 投递
   *
   * Agent 执行次数严格等于「去重后的 agent mention 数」:
   * 无 @ / 仅 @用户 → 0 次(绝不用 Composer 的默认 Leader 兜底)。
   */
  sendChatMessage(
    channelId: string,
    user: ActingUser,
    input: { text: string, mentions?: ChatMention[], replyToId?: string | null, clientMessageId?: string },
  ): {
    message: ChatMessageDto
    deliveries: Array<{ deliveryId: string, agentId: string, status: string }>
    duplicates: boolean
    unresolvedMentions: string[]
    /** 本次解析出的稳定 ID mention(含服务端从文本补解析的) */
    mentions: ChatMention[]
  } {
    // ① 守卫
    const channel = this.requireChannelChatEnabled(channelId, user)
    const text = String(input.text ?? '').trim()
    if (!text) throw new AppError(400, 'BAD_REQUEST', '消息文本不能为空')

    // ② 目标解析(权限/归属判定点)
    const { resolved, replyToId } = this.resolveChatTargets(channelId, text, input)

    // ③ 幂等(必须早于任何写:重复提交不得再产生投递/通知)
    const existing = input.clientMessageId
      ? this.chatMessageRepo.findByClientId(channelId, input.clientMessageId)
      : undefined
    if (existing) return this.replayChatMessage(existing)

    const agentTargets = agentMentions(resolved.mentions)
    const userTargets = userMentions(resolved.mentions).filter(m => m.id !== user.id)

    // ④ 同事务落库
    const { message, deliveries } = this.persistChatMessage({
      channelId,
      channelName: channel.name,
      user,
      text,
      mentions: resolved.mentions,
      replyToId,
      clientMessageId: input.clientMessageId,
      agentTargets,
      userTargets,
    })

    // ⑤ 事务已提交:发布阶段(失败不回滚)
    this.publishChatMessage(channelId, message.id)
    for (const m of userTargets) {
      this.publishNotification(`mention:${message.id}:${m.id}`)
    }

    // ⑥ @Agent → 生成 mailbox message(每条 delivery 恰好一次)
    const deliveryResults = deliveries.map(d => this.deliverChatToAgent(
      channelId, message.id, d.id, d.targetAgentId, text,
      { requesterUserId: user.id, requesterName: this.displayNameOf(user.id), mentions: resolved.mentions },
    ))

    this.auditChat('chat.send', channelId, user.id, {
      chatMessageId: message.id,
      agentTargets: agentTargets.map(m => m.id),
      userTargets: userTargets.map(m => m.id),
      hasReplyTo: !!replyToId,
    })

    return {
      message: projectChatMessage(message),
      deliveries: deliveryResults,
      duplicates: false,
      unresolvedMentions: resolved.unresolved,
      mentions: resolved.mentions,
    }
  }

  /**
   * 把一条群聊消息投递给单个 Agent(refresh-safe:同 chatMessage × agent 只一条投递)。
   * 走既有 mailbox 入口(route),metadata 携带全链路关联 ID。
   *
   * 三种收尾(未投递 / 已投递 / 抛错)共用 `finish` —— 原实现把"改台账 + 发投递事件"
   * 抄了三遍,漏改一处就会让某个分支的状态变更不推给前端(台账与 UI 分叉)。
   */
  protected deliverChatToAgent(
    channelId: string,
    chatMessageId: string,
    deliveryId: string,
    targetAgentId: string,
    text: string,
    ctx: { requesterUserId: string, requesterName: string, mentions: ChatMention[] },
  ): { deliveryId: string, agentId: string, status: string } {
    const finish = (
      status: 'delivered' | 'failed',
      opts: { mailboxMessageId?: string | null, error?: string } = {},
    ): { deliveryId: string, agentId: string, status: string } => {
      this.chatMessageRepo.updateDeliveryStatus(chatMessageId, targetAgentId, status, opts)
      this.publishChatDelivery(channelId, deliveryId)
      return { deliveryId, agentId: targetAgentId, status }
    }

    // 幂等兜底:投递已终结(consumed/delivered)→ 不重复入队
    const current = this.chatMessageRepo.findDelivery(chatMessageId, targetAgentId)
    if (current && current.status !== 'pending') {
      return { deliveryId, agentId: targetAgentId, status: current.status }
    }
    try {
      const message = buildMessage(channelId, 'ROLE_USER', [{ text: this.chatPromptText(ctx.requesterName, text) }], {
        'x-aw-target-agent': targetAgentId,
        'x-aw-msg-priority': 'immediate',
        // 人类发送者:稳定用户 id(权威)+ 展示名(渲染);禁止仅凭 fromLabel 归属
        'x-aw-from-user-id': ctx.requesterUserId,
        'x-aw-from-label': ctx.requesterName,
        // 全链路关联 ID(§13.6)
        'x-aw-source-chat-message-id': chatMessageId,
        'x-aw-requester-user-id': ctx.requesterUserId,
        'x-aw-delivery-id': deliveryId,
        'x-aw-reply-to': chatMessageId,
        'x-aw-require-reply': 'true',
        // 人类权限上下文(§13.3):发起者权限 ∩ Agent 授权能力
        'x-aw-permission-scope': JSON.stringify({
          invocationId: deliveryId,
          requesterUserId: ctx.requesterUserId,
          channelId,
          // 群成员不具备 Channel 管理权;跨 Channel / 私有 memory / 高危工具需 owner 显式授予
          scope: 'channel_member',
          canManageChannel: false,
          canUseHighRiskTools: false,
        }),
      })
      // 记为该 Agent 当前人类调用作用域:工具调用与 Agent 间委派都要按它收紧(§13.3)。
      this.activeInvocationScopes.set(targetAgentId, parseWorkshopPermissionScope(
        message.metadata?.[WORKSHOP_PERMISSION_SCOPE_HEADER],
      ) as WorkshopPermissionScope)
      const delivered = this.route(channelId, message)
      if (!delivered.includes(targetAgentId)) {
        return finish('failed', {
          mailboxMessageId: message.messageId,
          error: `未投递到 ${targetAgentId} 的 mailbox`,
        })
      }
      // mailbox messageId 回填台账:Agent 回复时经 in_reply_to 反查群聊来源
      return finish('delivered', { mailboxMessageId: message.messageId })
    }
    catch (err) {
      return finish('failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
