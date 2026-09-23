/**
 * 场景 H —— outbox 事务一致性:消息/投递落库同时登记 outbox 事件并收敛为 published;统计可达。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 569–588 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 *
 * 本段有刻意不参与断言的中间量(如 notifEvent),原样保留。
 */
import { check, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionH(ctx: GroupChatTestContext): Promise<void> {
  const { manager, buildChannel, B } = ctx
  section('H. outbox 事务一致性')
  const { channelId, workerId } = await buildChannel('outbox')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, B)
  const workerName = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.id === workerId)!.name
  const sent = manager.sendChatMessage(channelId, B, { text: `@${workerName} 干活`, clientMessageId: 'cm-outbox' })
  const outbox = manager.groupChat.outbox.listAll(200)
  const chatEvent = outbox.find(e => e.id === `chat.message:${sent.message.id}`)
  check('消息落库同时登记 outbox chat.message', !!chatEvent)
  check('outbox 已收敛为 published', chatEvent!.status === 'published', chatEvent!.status)
  const deliveryEvent = outbox.find(e => e.eventType === 'chat.delivery.status' && e.aggregateId === sent.deliveries[0]!.deliveryId)
  check('投递登记 outbox chat.delivery.status', !!deliveryEvent)
  // 通知也必须先落库(事实源)再发布
  const notifEvent = outbox.find(e => e.eventType === 'member.access_revoked')
  void notifEvent
  check('outbox 统计可达(可观测性)', typeof manager.groupChat.outbox.counts().pending === 'number')
}
