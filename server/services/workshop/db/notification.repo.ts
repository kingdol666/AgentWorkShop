/**
 * Notification 仓储 —— v17 用户级通知事实源(user_notifications)。
 *
 * 关键语义(主计划 §6):
 * - 通知**必须**按 recipient_user_id 定向;禁止把全局 `broadcastPeerEvent`(seq=0)当通知通道。
 * - `event_id` 是幂等键:同 (recipient, event) 只落一行(重复投递不产生重复弹窗)。
 * - 通知表是事实源:断线/刷新后按游标(created_at + rowid)补发。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { UserNotificationRow } from './database'

const COLS = 'id, recipient_user_id AS recipientUserId, channel_id AS channelId, chat_message_id AS chatMessageId, hitl_kind AS hitlKind, hitl_id AS hitlId, event_id AS eventId, type, title, body, payload_json AS payloadJson, created_at AS createdAt, read_at AS readAt'

export type NotificationType = 'mention' | 'agent_reply' | 'hitl_request' | 'hitl_resolved' | 'member'

export interface NotificationCreateInput {
  recipientUserId: string
  channelId?: string | null
  chatMessageId?: string | null
  hitlKind?: string | null
  hitlId?: string | null
  /** 幂等键(必填):建议 `${type}:${聚合 id}:${recipient}` 或事件 id */
  eventId: string
  type: NotificationType
  title?: string
  body?: string
  payload?: Record<string, unknown>
  id?: string
  createdAt?: string
}

export type NotificationRepo = ReturnType<typeof createNotificationRepo>

export function createNotificationRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO user_notifications (id, recipient_user_id, channel_id, chat_message_id, hitl_kind, hitl_id, event_id, type, title, body, payload_json, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  const selectByEvent = db.prepare(`SELECT ${COLS} FROM user_notifications WHERE recipient_user_id = ? AND event_id = ?`)
  const selectById = db.prepare(`SELECT ${COLS} FROM user_notifications WHERE id = ?`)
  const selectRecent = db.prepare(`SELECT ${COLS} FROM user_notifications WHERE recipient_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
  const selectUnread = db.prepare(`SELECT ${COLS} FROM user_notifications WHERE recipient_user_id = ? AND read_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`)
  const selectAfterCursor = db.prepare(
    `SELECT ${COLS} FROM user_notifications
     WHERE recipient_user_id = ?
       AND (created_at > ? OR (created_at = ? AND rowid > ?))
     ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  )
  const rowidOf = db.prepare(`SELECT rowid AS rid FROM user_notifications WHERE id = ?`)
  const createdOf = db.prepare(`SELECT created_at AS createdAt FROM user_notifications WHERE id = ?`)
  const countUnread = db.prepare(`SELECT COUNT(*) AS n FROM user_notifications WHERE recipient_user_id = ? AND read_at IS NULL`)
  const markReadStmt = db.prepare(`UPDATE user_notifications SET read_at = ? WHERE recipient_user_id = ? AND id = ? AND read_at IS NULL`)
  const markAllReadStmt = db.prepare(`UPDATE user_notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL`)
  const markChannelReadStmt = db.prepare(`UPDATE user_notifications SET read_at = ? WHERE recipient_user_id = ? AND channel_id = ? AND read_at IS NULL`)
  const deleteForRecipientStmt = db.prepare(`DELETE FROM user_notifications WHERE recipient_user_id = ?`)

  return {
    /**
     * 幂等写入通知。已存在 (recipient, eventId) 时返回既有行 + inserted=false。
     */
    create(input: NotificationCreateInput): { row: UserNotificationRow, inserted: boolean } {
      const existing = selectByEvent.get(input.recipientUserId, input.eventId) as unknown as UserNotificationRow | undefined
      if (existing) return { row: existing, inserted: false }
      const row: UserNotificationRow = {
        id: input.id ?? randomUUID(),
        recipientUserId: input.recipientUserId,
        channelId: input.channelId ?? null,
        chatMessageId: input.chatMessageId ?? null,
        hitlKind: input.hitlKind ?? null,
        hitlId: input.hitlId ?? null,
        eventId: input.eventId,
        type: input.type,
        title: input.title ?? '',
        body: input.body ?? '',
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: input.createdAt ?? new Date().toISOString(),
        readAt: null,
      }
      insert.run(
        row.id, row.recipientUserId, row.channelId, row.chatMessageId, row.hitlKind, row.hitlId,
        row.eventId, row.type, row.title, row.body, row.payloadJson, row.createdAt,
      )
      return { row, inserted: true }
    },

    findById(id: string): UserNotificationRow | undefined {
      return (selectById.get(id) as unknown as UserNotificationRow | undefined) ?? undefined
    },

    findByEventId(recipientUserId: string, eventId: string): UserNotificationRow | undefined {
      return (selectByEvent.get(recipientUserId, eventId) as unknown as UserNotificationRow | undefined) ?? undefined
    },

    listRecent(recipientUserId: string, limit = 50): UserNotificationRow[] {
      return selectRecent.all(recipientUserId, limit) as unknown as UserNotificationRow[]
    },

    listUnread(recipientUserId: string, limit = 100): UserNotificationRow[] {
      return selectUnread.all(recipientUserId, limit) as unknown as UserNotificationRow[]
    },

    /**
     * 游标补发:取 cursor 之后的通知(升序)。
     * cursor = { createdAt, id };缺省表示全量最近 limit 条(升序返回,便于前端顺序消费)。
     * 用 (created_at, rowid) 复合游标:同毫秒批量写入也不会丢/重。
     */
    listAfterCursor(recipientUserId: string, cursor: { createdAt: string, id: string } | null, limit = 200): UserNotificationRow[] {
      if (!cursor) {
        return (selectRecent.all(recipientUserId, limit) as unknown as UserNotificationRow[]).reverse()
      }
      const rid = (rowidOf.get(cursor.id) as { rid: number } | undefined)?.rid ?? 0
      return selectAfterCursor.all(recipientUserId, cursor.createdAt, cursor.createdAt, rid, limit) as unknown as UserNotificationRow[]
    },

    /** 由通知 id 构造游标(补发起点);不存在返回 null */
    cursorOf(id: string): { createdAt: string, id: string } | null {
      const c = createdOf.get(id) as { createdAt: string } | undefined
      if (!c) return null
      return { createdAt: c.createdAt, id }
    },

    unreadCount(recipientUserId: string): number {
      return Number((countUnread.get(recipientUserId) as { n: number } | undefined)?.n ?? 0)
    },

    /** 标记单条已读(仅本人;已读则返回 false 表示无变化) */
    markRead(recipientUserId: string, id: string): boolean {
      return markReadStmt.run(new Date().toISOString(), recipientUserId, id).changes > 0
    },

    markAllRead(recipientUserId: string): number {
      return Number(markAllReadStmt.run(new Date().toISOString(), recipientUserId).changes ?? 0)
    },

    markChannelRead(recipientUserId: string, channelId: string): number {
      return Number(markChannelReadStmt.run(new Date().toISOString(), recipientUserId, channelId).changes ?? 0)
    },

    /** 成员被移除/退出:清理其通知(不再补拉,§13.7) */
    deleteForRecipient(recipientUserId: string): number {
      return Number(deleteForRecipientStmt.run(recipientUserId).changes ?? 0)
    },

    /** 某频道的 HITL 通知(审批资格收紧后清理用) */
    deleteForChannelAgent(recipientUserId: string, channelId: string, hitlId: string): number {
      return Number(db.prepare(
        `DELETE FROM user_notifications WHERE recipient_user_id = ? AND channel_id = ? AND hitl_id = ?`,
      ).run(recipientUserId, channelId, hitlId).changes ?? 0)
    },
  }
}
