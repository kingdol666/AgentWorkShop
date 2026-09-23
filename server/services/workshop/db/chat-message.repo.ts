/**
 * ChatMessage / ChatDelivery 仓储 —— v17 群聊事实表 + 投递台账。
 *
 * 与既有 `messages`(Agent mailbox)双轨:
 * - `chat_messages` 是群聊的唯一事实源(历史、@、普通发言都在这里);
 * - Agent 调用只在 chat message 事务成功后生成 mailbox message,并由 `chat_deliveries`
 *   记录 (chatMessageId → mailboxMessageId) 映射,UNIQUE(chat_message_id, target_agent_id)
 *   保证「同一聊天消息对同一 Agent 只生成一条投递」。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChatDeliveryRow, ChatMessageRow } from './database'

const MSG_COLS = 'id, channel_id AS channelId, sender_type AS senderType, sender_id AS senderId, sender_name AS senderName, text, mentions_json AS mentionsJson, reply_to_id AS replyToId, requester_user_id AS requesterUserId, source_chat_message_id AS sourceChatMessageId, client_message_id AS clientMessageId, created_at AS createdAt'
const DELIVERY_COLS = 'id, chat_message_id AS chatMessageId, channel_id AS channelId, target_agent_id AS targetAgentId, mailbox_message_id AS mailboxMessageId, status, error, created_at AS createdAt, updated_at AS updatedAt'

/** 群聊 mention(稳定 ID;禁止昵称匹配) */
export interface ChatMention {
  type: 'user' | 'agent'
  id: string
  /** 展示名(服务端解析后回填;仅用于渲染) */
  label?: string
}

export interface ChatMessageCreateInput {
  channelId: string
  senderType: 'user' | 'agent' | 'system'
  senderId: string
  senderName?: string
  text: string
  mentions?: ChatMention[]
  replyToId?: string | null
  requesterUserId?: string | null
  sourceChatMessageId?: string | null
  /** 幂等键(同 channel 内唯一);缺省生成 */
  clientMessageId?: string
  id?: string
}

export type ChatDeliveryStatus = 'pending' | 'delivered' | 'consumed' | 'failed' | 'cancelled'

export type ChatMessageRepo = ReturnType<typeof createChatMessageRepo>

export function createChatMessageRepo(db: DatabaseSync) {
  const insertMessage = db.prepare(
    `INSERT INTO chat_messages (id, channel_id, sender_type, sender_id, sender_name, text, mentions_json, reply_to_id, requester_user_id, source_chat_message_id, client_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectMessageById = db.prepare(`SELECT ${MSG_COLS} FROM chat_messages WHERE id = ?`)
  const selectByClientId = db.prepare(`SELECT ${MSG_COLS} FROM chat_messages WHERE channel_id = ? AND client_message_id = ?`)
  const selectRecent = db.prepare(`SELECT ${MSG_COLS} FROM chat_messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
  const selectBefore = db.prepare(`SELECT ${MSG_COLS} FROM chat_messages WHERE channel_id = ? AND (created_at, rowid) < (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT ?`)
  const selectSince = db.prepare(`SELECT ${MSG_COLS} FROM chat_messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?`)
  const countMessages = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ?`)
  const countBySender = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ? AND sender_type = ?`)

  const insertDelivery = db.prepare(
    `INSERT INTO chat_deliveries (id, chat_message_id, channel_id, target_agent_id, mailbox_message_id, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectDeliveriesByMessage = db.prepare(`SELECT ${DELIVERY_COLS} FROM chat_deliveries WHERE chat_message_id = ? ORDER BY created_at ASC`)
  const selectDeliveryOne = db.prepare(`SELECT ${DELIVERY_COLS} FROM chat_deliveries WHERE chat_message_id = ? AND target_agent_id = ?`)
  const selectDeliveriesByAgent = db.prepare(`SELECT ${DELIVERY_COLS} FROM chat_deliveries WHERE channel_id = ? AND target_agent_id = ? ORDER BY created_at DESC LIMIT ?`)
  const countDeliveries = db.prepare(`SELECT COUNT(*) AS n FROM chat_deliveries WHERE channel_id = ?`)

  /** rowid 查询(游标分页用;created_at 同毫秒时不丢不重) */
  const rowidOf = db.prepare(`SELECT rowid AS rid FROM chat_messages WHERE id = ?`)

  return {
    /**
     * 写入一条群聊消息。**幂等**:同 (channelId, clientMessageId) 已存在时返回既有行
     * (不覆盖、不重复投递)。`inserted` 标记本次是否为真实插入。
     */
    create(input: ChatMessageCreateInput): { row: ChatMessageRow, inserted: boolean } {
      const clientMessageId = input.clientMessageId ?? randomUUID()
      const existing = selectByClientId.get(input.channelId, clientMessageId) as unknown as ChatMessageRow | undefined
      if (existing) return { row: existing, inserted: false }
      const row: ChatMessageRow = {
        id: input.id ?? randomUUID(),
        channelId: input.channelId,
        senderType: input.senderType,
        senderId: input.senderId,
        senderName: input.senderName ?? '',
        text: input.text,
        mentionsJson: JSON.stringify(input.mentions ?? []),
        replyToId: input.replyToId ?? null,
        requesterUserId: input.requesterUserId ?? null,
        sourceChatMessageId: input.sourceChatMessageId ?? null,
        clientMessageId,
        createdAt: new Date().toISOString(),
      }
      insertMessage.run(
        row.id, row.channelId, row.senderType, row.senderId, row.senderName, row.text,
        row.mentionsJson, row.replyToId, row.requesterUserId, row.sourceChatMessageId, row.clientMessageId, row.createdAt,
      )
      return { row, inserted: true }
    },

    findById(id: string): ChatMessageRow | undefined {
      return (selectMessageById.get(id) as unknown as ChatMessageRow | undefined) ?? undefined
    },

    findByClientId(channelId: string, clientMessageId: string): ChatMessageRow | undefined {
      return (selectByClientId.get(channelId, clientMessageId) as unknown as ChatMessageRow | undefined) ?? undefined
    },

    /** 最近 N 条(新→旧) */
    listRecent(channelId: string, limit = 50): ChatMessageRow[] {
      return selectRecent.all(channelId, limit) as unknown as ChatMessageRow[]
    },

    /** 游标分页:取 beforeId 之前的 limit 条(新→旧);beforeId 缺省 = 最新 */
    listBefore(channelId: string, beforeId: string | undefined, limit = 50): ChatMessageRow[] {
      if (!beforeId) return selectRecent.all(channelId, limit) as unknown as ChatMessageRow[]
      const anchor = rowidOf.get(beforeId) as { rid: number } | undefined
      const target = selectMessageById.get(beforeId) as unknown as ChatMessageRow | undefined
      if (!anchor || !target) return selectRecent.all(channelId, limit) as unknown as ChatMessageRow[]
      return selectBefore.all(channelId, target.createdAt, anchor.rid, limit) as unknown as ChatMessageRow[]
    },

    /** 增量拉取(after 时刻之后;上限 limit) */
    listSince(channelId: string, afterIso: string, limit = 200): ChatMessageRow[] {
      return selectSince.all(channelId, afterIso, limit) as unknown as ChatMessageRow[]
    },

    count(channelId: string): number {
      return Number((countMessages.get(channelId) as { n: number } | undefined)?.n ?? 0)
    },

    /** 按发送方类型计数(E2E「普通发言/`@用户` 的 Agent 执行计数为 0」取证用) */
    countBySenderType(channelId: string, senderType: string): number {
      return Number((countBySender.get(channelId, senderType) as { n: number } | undefined)?.n ?? 0)
    },

    /**
     * 幂等登记一次投递(同 chatMessage × agent 只一条)。
     * 已存在时返回既有行 + inserted=false(调用方据此跳过重复投递)。
     */
    createDelivery(input: {
      chatMessageId: string
      channelId: string
      targetAgentId: string
      mailboxMessageId?: string | null
      status?: ChatDeliveryStatus
      id?: string
    }): { row: ChatDeliveryRow, inserted: boolean } {
      const existing = selectDeliveryOne.get(input.chatMessageId, input.targetAgentId) as unknown as ChatDeliveryRow | undefined
      if (existing) return { row: existing, inserted: false }
      const now = new Date().toISOString()
      const row: ChatDeliveryRow = {
        id: input.id ?? randomUUID(),
        chatMessageId: input.chatMessageId,
        channelId: input.channelId,
        targetAgentId: input.targetAgentId,
        mailboxMessageId: input.mailboxMessageId ?? null,
        status: input.status ?? 'pending',
        error: '',
        createdAt: now,
        updatedAt: now,
      }
      insertDelivery.run(row.id, row.chatMessageId, row.channelId, row.targetAgentId, row.mailboxMessageId, row.status, row.error, row.createdAt, row.updatedAt)
      return { row, inserted: true }
    },

    /** 更新投递状态(可附 mailboxMessageId / error) */
    updateDeliveryStatus(
      chatMessageId: string,
      targetAgentId: string,
      status: ChatDeliveryStatus,
      opts: { mailboxMessageId?: string | null, error?: string } = {},
    ): boolean {
      const sets = ['status = ?', 'updated_at = ?']
      const args: Array<string | null> = [status, new Date().toISOString()]
      if (opts.mailboxMessageId !== undefined) {
        sets.push('mailbox_message_id = ?')
        args.push(opts.mailboxMessageId)
      }
      if (opts.error !== undefined) {
        sets.push('error = ?')
        args.push(opts.error)
      }
      args.push(chatMessageId, targetAgentId)
      return db.prepare(
        `UPDATE chat_deliveries SET ${sets.join(', ')} WHERE chat_message_id = ? AND target_agent_id = ?`,
      ).run(...args).changes > 0
    },

    /** 按 mailbox messageId 反查投递(Agent 回复关联链:mailbox → chat → requester) */
    findDeliveryByMailboxId(mailboxMessageId: string): ChatDeliveryRow | undefined {
      return (db.prepare(`SELECT ${DELIVERY_COLS} FROM chat_deliveries WHERE mailbox_message_id = ? LIMIT 1`)
        .get(mailboxMessageId) as unknown as ChatDeliveryRow | undefined) ?? undefined
    },

    listDeliveries(chatMessageId: string): ChatDeliveryRow[] {
      return selectDeliveriesByMessage.all(chatMessageId) as unknown as ChatDeliveryRow[]
    },

    findDelivery(chatMessageId: string, targetAgentId: string): ChatDeliveryRow | undefined {
      return (selectDeliveryOne.get(chatMessageId, targetAgentId) as unknown as ChatDeliveryRow | undefined) ?? undefined
    },

    /** 某 Agent 的最近投递(排障/E2E 取证) */
    listDeliveriesByAgent(channelId: string, targetAgentId: string, limit = 50): ChatDeliveryRow[] {
      return selectDeliveriesByAgent.all(channelId, targetAgentId, limit) as unknown as ChatDeliveryRow[]
    },

    countDeliveries(channelId: string): number {
      return Number((countDeliveries.get(channelId) as { n: number } | undefined)?.n ?? 0)
    },

    /** 成员被移除时:其名下 pending 投递置 cancelled(§13.7) */
    cancelPendingDeliveriesForAgent(channelId: string, targetAgentId: string): number {
      return Number(db.prepare(
        `UPDATE chat_deliveries SET status = 'cancelled', error = '成员已移除', updated_at = ?
         WHERE channel_id = ? AND target_agent_id = ? AND status IN ('pending', 'delivered')`,
      ).run(new Date().toISOString(), channelId, targetAgentId).changes ?? 0)
    },
  }
}
