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
  const selectAnyByEvent = db.prepare(`SELECT ${COLS} FROM user_notifications WHERE event_id = ? LIMIT 1`)
  /** 游标锚点丢失时的退化路径:严格大于该时刻(同毫秒的行无法再定位) */
  const selectAfterCreatedAt = db.prepare(
    `SELECT ${COLS} FROM user_notifications WHERE recipient_user_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  )
  const rowidOf = db.prepare(`SELECT rowid AS rid FROM user_notifications WHERE id = ?`)
  const createdOf = db.prepare(`SELECT created_at AS createdAt FROM user_notifications WHERE id = ?`)
  const countUnread = db.prepare(`SELECT COUNT(*) AS n FROM user_notifications WHERE recipient_user_id = ? AND read_at IS NULL`)
  const markReadStmt = db.prepare(`UPDATE user_notifications SET read_at = ? WHERE recipient_user_id = ? AND id = ? AND read_at IS NULL`)
  const markAllReadStmt = db.prepare(`UPDATE user_notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL`)
  const markChannelReadStmt = db.prepare(`UPDATE user_notifications SET read_at = ? WHERE recipient_user_id = ? AND channel_id = ? AND read_at IS NULL`)
  const deleteForRecipientStmt = db.prepare(`DELETE FROM user_notifications WHERE recipient_user_id = ?`)
  /** 撤权清理:只删该用户在**该频道**的通知(不波及其它频道) */
  const deleteChannelForRecipientStmt = db.prepare(`DELETE FROM user_notifications WHERE recipient_user_id = ? AND channel_id = ?`)
  /** 保留期清理:删除 created_at 早于给定时刻的**已读**通知(表按时间有界;未读永不清理) */
  const sweepReadStmt = db.prepare(`DELETE FROM user_notifications WHERE read_at IS NOT NULL AND created_at < ?`)

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

    /**
     * 按 eventId 跨 recipient 取整行("刚写入的通知"发布用,调用方手上只有 eventId)。
     *
     * 前置约定:`eventId` 在实践中**全局唯一** —— 所有生成点都把聚合 id 与 recipient
     * 编进键里(`mention:<chatMessageId>:<userId>` / `agent_reply:<chatMessageId>:<userId>` /
     * `hitl_request:<hitlId>:<userId>` …)。表上的唯一约束是 `(recipient_user_id, event_id)`,
     * 因此这里 `LIMIT 1` 是安全的;若将来引入可跨 recipient 复用的 eventId,
     * 发布路径必须改为显式传 recipient(而不是依赖本方法)。
     */
    findAnyByEventId(eventId: string): UserNotificationRow | undefined {
      return (selectAnyByEvent.get(eventId) as unknown as UserNotificationRow | undefined) ?? undefined
    },

    listRecent(recipientUserId: string, limit = 50): UserNotificationRow[] {
      return selectRecent.all(recipientUserId, limit) as unknown as UserNotificationRow[]
    },

    listUnread(recipientUserId: string, limit = 100): UserNotificationRow[] {
      return selectUnread.all(recipientUserId, limit) as unknown as UserNotificationRow[]
    },

    /**
     * 游标补发:取 cursor 之后的通知(升序)。
     *
     * cursor = { createdAt, id };`null` 表示"没有游标"→ 返回最近 limit 条(升序)。
     * 复合游标 `(created_at, rowid)`:同毫秒批量写入也不丢不重。
     *
     * **游标行已不存在时**不能把 rowid 退化成 0 —— 那会返回所有 created_at 等于该时刻的行
     * (重复投递)。此时改为严格的 `created_at > ?`,只可能漏掉"同一毫秒且排在原行之后"的行,
     * 而那种行本就无法定位(锚点已删),属可接受退化。
     */
    listAfterCursor(recipientUserId: string, cursor: { createdAt: string, id: string } | null, limit = 200): UserNotificationRow[] {
      if (!cursor) {
        return (selectRecent.all(recipientUserId, limit) as unknown as UserNotificationRow[]).reverse()
      }
      const rid = (rowidOf.get(cursor.id) as { rid: number } | undefined)?.rid
      if (rid === undefined) {
        return selectAfterCreatedAt.all(recipientUserId, cursor.createdAt, limit) as unknown as UserNotificationRow[]
      }
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

    /**
     * 成员被移除/退出:清理其通知,使其**不再补拉**(§13.7
     * "removed 成员立即失去读、发言、审批、通知补拉权限")。
     *
     * 按 channel 限定:全量 `deleteForRecipient` 会连带抹掉该用户**其它频道**的通知,
     * 而撤权只针对一个 Channel。`channelId` 为空时退化为全量清理(账号注销等场景)。
     */
    deleteForChannel(recipientUserId: string, channelId: string | null): number {
      if (!channelId) {
        return Number(deleteForRecipientStmt.run(recipientUserId).changes ?? 0)
      }
      return Number(deleteChannelForRecipientStmt.run(recipientUserId, channelId).changes ?? 0)
    },

    /**
     * 保留期清理:删除 `created_at < beforeIso` 的**已读**通知,返回清理行数。
     *
     * 按 `created_at`(而非 `read_at`)判龄:保留期的目的是让表**按时间有界**,
     * 若按 read_at 判龄,"很久以前创建、刚刚才读"的行会再存活一整个窗口,
     * 表的有界性取决于用户何时点开,不可预测。
     *
     * **未读行永不清理** —— 未读是"用户还没看到"的事实,删掉就是丢通知。
     * 已读且过期的行可以回收:客户端游标只推进不回退,补发不需要远古已读行;
     * 即使游标恰好指向被删行,`listAfterCursor` 也有"锚点缺失"的安全退化路径。
     */
    sweepRead(beforeIso: string): number {
      return Number(sweepReadStmt.run(beforeIso).changes ?? 0)
    },
  }
}
