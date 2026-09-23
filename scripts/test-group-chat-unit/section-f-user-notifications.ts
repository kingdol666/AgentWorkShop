/**
 * 场景 F —— 用户通知:eventId 幂等;跨用户零泄漏;游标补发;成员被移除后通知端点也过不了成员守卫。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 489–530 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 *
 * 本段用 ctx.mkUser 注册专用用户(N1/N2),与前述小节的通知互不污染。
 */
import { check, checkThrows, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionF(ctx: GroupChatTestContext): Promise<void> {
  const { manager, buildChannel, mkUser, A } = ctx
  section('F. 用户通知:eventId 幂等 / 跨用户隔离 / 游标补发')
  const { channelId } = await buildChannel('notify')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  // 专用用户:避免与前述小节的通知互相污染(隔离断言必须只看本节数据)
  const N1 = mkUser('notify-one')
  const N2 = mkUser('notify-two')
  manager.joinChannel(channelId, N1)
  manager.joinChannel(channelId, N2)

  const n1 = manager.notifyUser({ recipientUserId: N1.id, channelId, type: 'mention', eventId: 'evt-1', title: 't1' })
  const n1again = manager.notifyUser({ recipientUserId: N1.id, channelId, type: 'mention', eventId: 'evt-1', title: 't1-dup' })
  check('同 (recipient,eventId) 幂等:第二次 inserted=false', n1.inserted && !n1again.inserted)
  check('幂等不产生第二行', n1.id === n1again.id)
  const bList = manager.listNotifications(N1.id, { limit: 50 })
  const cList = manager.listNotifications(N2.id, { limit: 50 })
  check('通知按 recipientUserId 隔离:N1 有、N2 无', bList.length === 1 && cList.length === 0, `N1=${bList.length} N2=${cList.length}`)
  check('未读数只属于本人', manager.groupChat.notifications.unreadCount(N1.id) === 1 && manager.groupChat.notifications.unreadCount(N2.id) === 0)

  // 游标补发:取 N1 第一条为游标 → 只拿到其后新增
  manager.notifyUser({ recipientUserId: N1.id, channelId, type: 'agent_reply', eventId: 'evt-2', title: 't2' })
  const cursor0 = manager.groupChat.notifications.cursorOf(n1.id)!
  const after = manager.listNotificationsAfter(N1.id, cursor0, 50)
  check('游标补发:仅返回游标之后的通知', after.length === 1 && after[0]!.eventId === 'evt-2', `len=${after.length}`)
  const all = manager.listNotificationsAfter(N1.id, null, 50)
  check('无游标 → 返回全部(升序)', all.length === 2 && all[0]!.eventId === 'evt-1', `len=${all.length}`)
  // 已读
  const readRes = manager.markNotificationsRead(N1.id, { id: n1.id })
  check('标记单条已读', readRes.count === 1 && manager.groupChat.notifications.unreadCount(N1.id) === 1)
  const readAll = manager.markNotificationsRead(N1.id, { all: true })
  check('标记全部已读', readAll.count === 1 && manager.groupChat.notifications.unreadCount(N1.id) === 0)
  check('已读不影响他人', manager.groupChat.notifications.unreadCount(N2.id) === 0)

  // 成员被移除 → 通知不再可拉取(访问撤销)
  manager.notifyUser({ recipientUserId: N2.id, channelId, type: 'mention', eventId: 'evt-3', title: 't3' })
  check('N2 有 1 条通知', manager.groupChat.notifications.listRecent(N2.id, 10).length === 1)
  manager.removeChannelMember(channelId, A, N2.id)
  checkThrows('移除后不可再读群聊', () => manager.requireChannelMember(channelId, N2), 'NOT_CHANNEL_MEMBER')
  checkThrows('移除后通知端点也无法通过成员守卫(路由层同口径)', () => manager.requireChannelMember(channelId, N2), 'NOT_CHANNEL_MEMBER')
}
