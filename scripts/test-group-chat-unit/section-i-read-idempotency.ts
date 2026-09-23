/**
 * 场景 I —— 会话中立的幂等:重复读历史不产生副作用、新→旧排序、before 游标分页。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 590–605 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 */
import { check, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionI(ctx: GroupChatTestContext): Promise<void> {
  const { manager, buildChannel, B } = ctx
  section('I. 会话中立的幂等:重复读历史不产生副作用')
  const { channelId } = await buildChannel('readonly')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, B)
  manager.sendChatMessage(channelId, B, { text: 'one', clientMessageId: 'r1' })
  manager.sendChatMessage(channelId, B, { text: 'two', clientMessageId: 'r2' })
  const list1 = manager.listChatMessages(channelId, B, { limit: 50 })
  const list2 = manager.listChatMessages(channelId, B, { limit: 50 })
  check('读历史幂等(两次结果一致)', JSON.stringify(list1) === JSON.stringify(list2))
  check('历史新→旧排序', list1[0]!.text === 'two' && list1[1]!.text === 'one')
  const older = manager.listChatMessages(channelId, B, { before: list1[0]!.id, limit: 50 })
  check('before 游标分页取更早消息', older.length === 1 && older[0]!.text === 'one')
}
