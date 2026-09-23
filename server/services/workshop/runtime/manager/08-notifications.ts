/**
 * ManagerNotifications —— 用户级通知与群聊审计
 * (分层 9/19,承 ManagerChatReply)
 */
import { ManagerChatReply } from './07-chat-reply'
import type { NotificationRepo } from '../../db/notification.repo'
import type { PublicChannelMemberDto } from '../chat-projection'
import { log } from './helpers'
import { projectChannelMember, projectNotification } from '../chat-projection'
import { publishToUser } from '../user-notification-hub'

export abstract class ManagerNotifications extends ManagerChatReply {
  /**
   * 通知发布:表为事实源,落库后经用户 hub 定向推送(§6 禁止 broadcastPeerEvent)。
   *
   * 调用方此刻只有 `eventId`(聚合 id 已编进键里),故按 eventId 跨 recipient 取行;
   * 行不存在说明落库失败或已被清理 —— 静默跳过是正确语义(通知本就"至少一次",不因发布失败产错)。
   */
  protected publishNotification(eventId: string): void {
    const row = this.notificationRepo.findAnyByEventId(eventId)
    if (!row) return
    publishToUser(row.recipientUserId, 'notification.created', projectNotification(row), { eventId: row.eventId })
  }

  /**
   * 对某个用户直接投递一条通知(持久化 + 定向推送)。
   * 供群聊/HITL/成员变更共用;幂等由 (recipient, eventId) 唯一键保证。
   */
  notifyUser(input: {
    recipientUserId: string
    channelId?: string | null
    type: 'mention' | 'agent_reply' | 'hitl_request' | 'hitl_resolved' | 'member'
    eventId: string
    title?: string
    body?: string
    chatMessageId?: string | null
    hitlKind?: string | null
    hitlId?: string | null
    payload?: Record<string, unknown>
  }): { id: string, inserted: boolean } {
    const { row, inserted } = this.notificationRepo.create({
      recipientUserId: input.recipientUserId,
      channelId: input.channelId ?? null,
      chatMessageId: input.chatMessageId ?? null,
      hitlKind: input.hitlKind ?? null,
      hitlId: input.hitlId ?? null,
      eventId: input.eventId,
      type: input.type,
      title: input.title ?? '',
      body: input.body ?? '',
      payload: input.payload ?? {},
    })
    publishToUser(row.recipientUserId, 'notification.created', projectNotification(row), { eventId: row.eventId })
    return { id: row.id, inserted }
  }

  /** 通知列表(本人;分页) */
  listNotifications(userId: string, opts: { limit?: number, unreadOnly?: boolean } = {}): Array<ReturnType<NotificationRepo['listRecent']>[number]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    return opts.unreadOnly ? this.notificationRepo.listUnread(userId, limit) : this.notificationRepo.listRecent(userId, limit)
  }

  /** 断线补发:按游标取通知(升序;事实源 = user_notifications) */
  listNotificationsAfter(userId: string, cursor: { createdAt: string, id: string } | null, limit = 200): Array<ReturnType<NotificationRepo['listRecent']>[number]> {
    return this.notificationRepo.listAfterCursor(userId, cursor, limit)
  }

  /** 标记已读(单条 / 频道范围 / 全部)+ 多标签页同步 */
  markNotificationsRead(userId: string, opts: { id?: string, channelId?: string, all?: boolean }): { count: number, id?: string, channelId?: string } {
    let count: number
    if (opts.id) count = this.notificationRepo.markRead(userId, opts.id) ? 1 : 0
    else if (opts.channelId) count = this.notificationRepo.markChannelRead(userId, opts.channelId)
    else count = this.notificationRepo.markAllRead(userId)
    try {
      publishToUser(userId, 'notification.read', {
        recipientUserId: userId,
        id: opts.id,
        channelId: opts.channelId,
        readAt: new Date().toISOString(),
        count,
      }, { eventId: `read:${userId}:${opts.id ?? opts.channelId ?? 'all'}:${Date.now()}` })
    }
    catch (err) {
      log.error('[notification] 已读事件发布失败:', err)
    }
    return { count, id: opts.id, channelId: opts.channelId }
  }

  /** 群聊操作审计(与 auditMemberChange 共用同一写入口;审计失败不影响主流程) */
  protected auditChat(action: string, channelId: string, actor: string, detail: Record<string, unknown>): void {
    this.auditUserAction(action, 'channel-chat', channelId, actor, { channelId, ...detail })
  }

  /**
   * 群成员投影列表(REST 用;不含凭据)。
   *
   * 与快照路径共用 `projectChannelMember` —— 此前这里另写了一份字段映射,
   * 且 `displayName` 用的是**没有 id 前缀兜底**的 `resolveOwnerName`(用户名解析失败时
   * 返回 null),而快照路径用 `displayNameOf`(回落 id 前 8 位)。同一份成员数据在
   * 列表与快照里显示不同,属真实不一致;现在两处都走 `displayNameOf`。
   */
  listChannelMembersProjected(channelId: string): PublicChannelMemberDto[] {
    return this.channelMemberRepo.listByChannel(channelId)
      .map(m => projectChannelMember(m, this.displayNameOf(m.userId)))
  }

  // ===== Workspace(服务端持久化;按 owner 隔离)=====
}
