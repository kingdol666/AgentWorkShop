/**
 * ManagerChatReply —— 群聊回复回写与事件发布
 * (拆分层,承 ManagerChat)
 */
import { ManagerChat } from './chat'
import type { ChannelMemberRow } from '../../db/database'
import type { ChatMention } from '../../db/chat-message.repo'
import type { ChatMessageDto } from '../chat-projection'
import { log } from './helpers'
import { projectChannel, projectChatMessage } from '../chat-projection'
import { randomUUID } from 'node:crypto'

export abstract class ManagerChatReply extends ManagerChat {
  /** 群聊 → Agent 的提示词正文(显式带上提问者,Agent 无需猜"最近发言者") */
  protected chatPromptText(requesterName: string, text: string): string {
    return `[群聊] ${requesterName} 提问:${text}\n(请回复内容;系统会把你的回复作为群聊消息发出并自动 @${requesterName})`
  }

  /**
   * Agent 回复写入群聊(主计划 §7)。
   *
   * 由 AgentRuntime.platformReply 调用;`sourceChatMessageId` / `requesterUserId` 来自
   * 入站 mailbox metadata(服务端盖章,不可伪造)。回复**公开**展示在群聊,
   * 服务端自动为 requesterUserId 增加 mention 与定向通知;**不**触发其他 Agent(防循环)。
   */
  agentReplyToChat(input: {
    channelId: string
    agentId: string
    agentName: string
    text: string
    sourceChatMessageId?: string
    requesterUserId?: string
    inReplyTo?: string
  }): ChatMessageDto | null {
    const channelId = input.channelId
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel || channel.chatEnabled !== 1) return null
    const text = String(input.text ?? '').trim()
    if (!text) return null

    // 关联链解析:优先平台盖章的 metadata;兼容仅有 inReplyTo(mailbox messageId)的旧路径
    let sourceChatMessageId = input.sourceChatMessageId ?? null
    let requesterUserId = input.requesterUserId ?? null
    if ((!sourceChatMessageId || !requesterUserId) && input.inReplyTo) {
      const source = this.chatMessageRepo.findDeliveryByMailboxId(input.inReplyTo)
      if (source) {
        sourceChatMessageId = sourceChatMessageId ?? source.chatMessageId
        const src = this.chatMessageRepo.findById(source.chatMessageId)
        requesterUserId = requesterUserId ?? src?.requesterUserId ?? null
      }
      else {
        const direct = this.chatMessageRepo.findById(input.inReplyTo)
        if (direct) {
          sourceChatMessageId = sourceChatMessageId ?? direct.id
          requesterUserId = requesterUserId ?? direct.requesterUserId ?? direct.senderId
        }
      }
    }
    // 兜底:sourceChatMessageId 存在时从中补 requesterUserId(绝不用"最近发言者"推断)
    if (sourceChatMessageId && !requesterUserId) {
      requesterUserId = this.chatMessageRepo.findById(sourceChatMessageId)?.requesterUserId ?? null
    }

    const mentions: ChatMention[] = []
    if (requesterUserId) {
      mentions.push({ type: 'user', id: requesterUserId, label: this.displayNameOf(requesterUserId) })
    }

    const { row } = this.inTransaction(() => {
      const created = this.chatMessageRepo.create({
        channelId,
        senderType: 'agent',
        senderId: input.agentId,
        senderName: input.agentName,
        text,
        mentions,
        replyToId: sourceChatMessageId,
        requesterUserId,
        sourceChatMessageId,
        clientMessageId: `agent-reply:${input.agentId}:${sourceChatMessageId ?? randomUUID()}:${Date.now()}`,
      })
      if (requesterUserId) {
        this.notificationRepo.create({
          recipientUserId: requesterUserId,
          channelId,
          chatMessageId: created.row.id,
          eventId: `agent_reply:${created.row.id}:${requesterUserId}`,
          type: 'agent_reply',
          title: `${input.agentName} 回复了你`,
          body: text.slice(0, 200),
          payload: { channelId, chatMessageId: created.row.id, agentId: input.agentId, sourceChatMessageId },
        })
      }
      this.outboxRepo.enqueue({
        aggregateType: 'chat_message',
        aggregateId: created.row.id,
        eventType: 'chat.message',
        payload: { channelId, chatMessageId: created.row.id, senderType: 'agent' },
        eventId: `chat.message:${created.row.id}`,
      })
      // 源消息的投递台账收敛为 consumed(闭环留痕)
      if (sourceChatMessageId) {
        const d = this.chatMessageRepo.listDeliveries(sourceChatMessageId).find(x => x.targetAgentId === input.agentId)
        if (d) this.chatMessageRepo.updateDeliveryStatus(sourceChatMessageId, input.agentId, 'consumed')
      }
      return { row: created.row }
    })

    this.publishChatMessage(channelId, row.id)
    if (requesterUserId) {
      this.publishNotification(`agent_reply:${row.id}:${requesterUserId}`)
    }
    return projectChatMessage(row)
  }

  /**
   * 群聊事件发布的**唯一出口**(chat.message / chat.delivery.status / chat.member / chat.settings)。
   *
   * 为什么收敛成一个方法:原先四个 `publishXxx*` 各自展开 `try { buses.get(...)?.notifyChat?.(...) }
   * catch { log }`,任一处漏掉 try 就会把"广播失败"抛回业务路径 —— 而此时消息**已经落库**,
   * 抛出去会让调用方以为整体失败(违反"广播失败不回滚消息"的约定:落库即事实)。
   * 统一后只有一处需要保证该不变量,新增事件类型也不再重复这段样板。
   *
   * @param opts.outboxEventId 有值时把该 outbox 行从 pending 收敛为 published(幂等条件更新)
   */
  protected publishChatEvent(channelId: string, type: string, payload: unknown, opts: { outboxEventId?: string } = {}): void {
    try {
      this.buses.get(channelId)?.notifyChat?.({ type, payload })
      if (opts.outboxEventId) this.outboxRepo.markPublishedIfPending(opts.outboxEventId)
    }
    catch (err) {
      log.error(`[chat] ${type} 发布失败(已落库,不回滚):`, err)
    }
  }

  /** 发布 channel 流群聊消息(seq/环形缓冲/落库/重放复用既有 hub 机制) */
  protected publishChatMessage(channelId: string, chatMessageId: string): void {
    const row = this.chatMessageRepo.findById(chatMessageId)
    if (!row) return
    this.publishChatEvent(channelId, 'chat.message', projectChatMessage(row), {
      outboxEventId: `chat.message:${chatMessageId}`,
    })
  }

  /** 自动发送投递台账事件 + 收敛 outbox(与 publishChatEvent 的 outboxEventId 约定配套) */
  protected publishChatDelivery(channelId: string, deliveryId: string): void {
    const row = this.chatMessageRepo.findDeliveryById(deliveryId)
    if (!row) return
    this.publishChatEvent(channelId, 'chat.delivery.status', {
      deliveryId,
      chatMessageId: row.chatMessageId,
      channelId,
      targetAgentId: row.targetAgentId,
      mailboxMessageId: row.mailboxMessageId,
      status: row.status as 'pending' | 'delivered' | 'consumed' | 'failed' | 'cancelled',
      error: row.error,
      updatedAt: row.updatedAt,
    }, { outboxEventId: `chat.delivery.status:${deliveryId}` })
  }

  /** 发布群成员变更事件 */
  publishChatMember(channelId: string, row: ChannelMemberRow, op: 'joined' | 'left' | 'removed' | 'approved' | 'updated', by?: string): void {
    this.publishChatEvent(channelId, 'chat.member', {
      userId: row.userId,
      displayName: this.displayNameOf(row.userId),
      role: row.role as 'owner' | 'member',
      status: row.status as 'active' | 'pending' | 'left' | 'removed',
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
      op,
      by,
    })
  }

  /** 发布群聊设置变更事件 */
  publishChatSettings(channelId: string): void {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) return
    this.publishChatEvent(channelId, 'chat.settings', projectChannel(channel))
  }
}
