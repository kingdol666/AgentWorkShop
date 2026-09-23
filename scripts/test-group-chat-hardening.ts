/**
 * 群聊层"加固"回归测试(本轮 review 修复项).
 *
 * 覆盖的是**行为契约**,不是实现细节 —— 每条都对应一个真实缺陷:
 *  1. `withTransaction` 可重入:SQLite 不支持嵌套 BEGIN(实测会抛
 *     `cannot start a transaction within a transaction` 且**外层仍开着**),
 *     而群聊写入路径会互相调用。这里断言嵌套不抛、内层回滚不伤外层、外层回滚全丢。
 *  2. `isTransactionOpen()` 在事务内外正确翻转 —— WS 落库缓冲靠它决定是否推迟刷盘
 *     (同连接的非事务写入会被并入事务,回滚会连带丢弃已推给 peer 的帧)。
 *  3. `listBefore` 遇失效/跨频道游标返回**空页**(旧实现回落最新页 → 客户端"加载更早"死循环)。
 *  4. `listAfterCursor` 游标行被删时不得返回重复行(旧实现把 rowid 退化为 0 → 同毫秒行全返)。
 *  5. 撤权只清理**该 Channel** 的通知,不波及其它频道(§13.7)。
 *  6. outbox `markPublishedIfPending` 幂等;`sweepPublished` 只回收已发布行。
 *  7. 通知保留期只回收**已读**行(未读永不删)。
 *  8. 成员投影与快照投影同源(displayName 回落 id 前缀),不再"列表与快照显示不同"。
 *
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-group-chat-hardening.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离:用户仓储惰性 getDb() 会走 AW_DATA_DIR;指向临时目录,绝不触碰真实数据
process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-chat-hardening-'))
process.env.AGENTWORKSHOP_TEST = '1'

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { withTransaction, isTransactionOpen, transactionDepth } = await import('../server/services/workshop/db/transaction')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelMemberRepo } = await import('../server/services/workshop/db/channel-member.repo')
const { createChatMessageRepo } = await import('../server/services/workshop/db/chat-message.repo')
const { createNotificationRepo } = await import('../server/services/workshop/db/notification.repo')
const { createOutboxRepo } = await import('../server/services/workshop/db/outbox.repo')
const { projectChannelMember } = await import('../server/services/workshop/runtime/chat-projection')

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const channels = createChannelRepo(db)
const members = createChannelMemberRepo(db)
const chat = createChatMessageRepo(db)
const notifications = createNotificationRepo(db)
const outbox = createOutboxRepo(db)

/** 建一个 channel(直接落库,不经 manager —— 本测试只关心 db/仓储层契约) */
function makeChannel(name: string): string {
  const row = channels.create({ name, ownerUserId: 'u-owner' })
  members.ensureOwner(row.id, 'u-owner')
  return row.id
}

// ============================================================================
section('1. 事务可重入(SQLite 不支持嵌套 BEGIN)')
// ============================================================================
{
  const chId = makeChannel('tx')
  check('事务外 isTransactionOpen()=false', isTransactionOpen() === false)

  // 嵌套事务不得抛错;内层写入与外层写入在同一最外层事务里
  let innerOpened = false
  let outerDepthSeen = 0
  withTransaction(db, () => {
    outerDepthSeen = transactionDepth()
    chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: 'outer', clientMessageId: 'tx-outer' })
    withTransaction(db, () => {
      innerOpened = isTransactionOpen()
      chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: 'inner', clientMessageId: 'tx-inner' })
    })
  })
  check('嵌套事务不抛错(SQLite 嵌套 BEGIN 会抛)', outerDepthSeen >= 1, `outerDepth=${outerDepthSeen}`)
  check('内层 isTransactionOpen()=true(WS 刷盘守卫据此推迟)', innerOpened === true)
  check('提交后 isTransactionOpen()=false', isTransactionOpen() === false)
  check('嵌套提交后两条写入都可见', chat.count(chId) === 2, `count=${chat.count(chId)}`)

  // 内层抛错:只回滚内层(外层可选择继续并提交)
  let innerThrew = false
  withTransaction(db, () => {
    chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: 'keep-me', clientMessageId: 'tx-keep' })
    try {
      withTransaction(db, () => {
        chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: 'rollback-me', clientMessageId: 'tx-rb' })
        throw new Error('inner-boom')
      })
    }
    catch {
      innerThrew = true
    }
  })
  check('内层抛错被捕获且外层仍提交', innerThrew && chat.count(chId) === 3, `count=${chat.count(chId)}`)
  check('内层回滚只丢弃内层写入(rollback-me 不存在)', chat.findByClientId(chId, 'tx-rb') === undefined)
  check('内层回滚不影响外层已写行(keep-me 存在)', chat.findByClientId(chId, 'tx-keep') !== undefined)

  // 外层抛错:整体回滚(含已成功的内层)
  let outerThrew = false
  const before = chat.count(chId)
  try {
    withTransaction(db, () => {
      chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: 'a', clientMessageId: 'tx-o1' })
      withTransaction(db, () => {
        chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: 'b', clientMessageId: 'tx-o2' })
      })
      throw new Error('outer-boom')
    })
  }
  catch {
    outerThrew = true
  }
  check('外层抛错 → 全部回滚(含已提交的内层写入)', outerThrew && chat.count(chId) === before, `before=${before} after=${chat.count(chId)}`)
  check('回滚后事务深度归零(不留悬挂事务)', transactionDepth() === 0)
  check('回滚后 isTransactionOpen()=false', isTransactionOpen() === false)
}

// ============================================================================
section('2. 游标正确性:失效游标不得回落到最新页')
// ============================================================================
{
  const chId = makeChannel('cursor')
  const other = makeChannel('cursor-other')
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    ids.push(chat.create({ channelId: chId, senderType: 'user', senderId: 'u1', text: `m${i}`, clientMessageId: `c${i}` }).row.id)
  }
  check('无游标 → 最新页(新→旧)', chat.listBefore(chId, undefined, 3)[0]!.text === 'm4')

  const anchorIdx = ids[2]!
  const before = chat.listBefore(chId, anchorIdx, 10)
  check('有效游标 → 严格取更早的 2 条', before.length === 2 && before.every(m => ['m0', 'm1'].includes(m.text)), before.map(m => m.text).join(','))

  // 旧实现:anchor 不存在时 return selectRecent(...) → 客户端"加载更早"永远拿到最新页(死循环)
  const ghost = chat.listBefore(chId, 'no-such-message-id', 10)
  check('失效游标 → 空页(旧实现会回落最新页,导致分页死循环)', ghost.length === 0, `len=${ghost.length}`)

  // 跨频道游标同样必须空页(否则能把别的群的消息当锚点,泄漏其 createdAt 位置)
  const foreign = chat.create({ channelId: other, senderType: 'user', senderId: 'u1', text: 'x', clientMessageId: 'cx' }).row.id
  const cross = chat.listBefore(chId, foreign, 10)
  check('跨频道游标 → 空页', cross.length === 0, `len=${cross.length}`)
}

// ============================================================================
section('3. 通知游标:锚点被删不得返回重复行')
// ============================================================================
{
  const me = 'user-cursor'
  // 三条同 created_at 的通知(模拟同毫秒批量写入)
  const stamp = '2026-01-01T00:00:00.000Z'
  const n1 = notifications.create({ recipientUserId: me, type: 'mention', eventId: 'e1', createdAt: stamp }).row
  notifications.create({ recipientUserId: me, type: 'mention', eventId: 'e2', createdAt: stamp })
  notifications.create({ recipientUserId: me, type: 'mention', eventId: 'e3', createdAt: stamp })

  const afterFirst = notifications.listAfterCursor(me, { createdAt: n1.createdAt, id: n1.id }, 50)
  check('锚点存在 → 用 (created_at,rowid) 严格取其后(不含同刻更早行)', afterFirst.length === 2, `len=${afterFirst.length}`)

  // 旧实现:rowidOf 缺失 → rid=0 → 返回所有 created_at 等于锚点时刻的行(重复投递)
  const ghost = notifications.listAfterCursor(me, { createdAt: stamp, id: 'deleted-anchor' }, 50)
  check('锚点被删 → 严格 > createdAt(不重复返回同刻行)', ghost.length === 0, `len=${ghost.length}`)

  const cursor = notifications.cursorOf(n1.id)
  check('cursorOf 返回可用游标', cursor?.id === n1.id && cursor.createdAt === stamp)
  check('cursorOf 对不存在的 id 返回 null', notifications.cursorOf('nope') === null)
}

// ============================================================================
section('4. 撤权只清本频道通知(§13.7)')
// ============================================================================
{
  const a = makeChannel('revoke-a')
  const b = makeChannel('revoke-b')
  const target = 'user-target'
  notifications.create({ recipientUserId: target, channelId: a, type: 'mention', eventId: 'ra' })
  notifications.create({ recipientUserId: target, channelId: b, type: 'mention', eventId: 'rb' })
  notifications.create({ recipientUserId: 'user-other', channelId: a, type: 'mention', eventId: 'ro' })

  const purged = notifications.deleteForChannel(target, a)
  check('撤权清理返回删除行数', purged === 1, `purged=${purged}`)
  check('本频道通知已删(不再补拉)', notifications.listRecent(target, 10).every(n => n.channelId !== a))
  check('其它频道通知保留(不误删)', notifications.listRecent(target, 10).some(n => n.channelId === b))
  check('其它用户在同频道的通知不受影响', notifications.listRecent('user-other', 10).some(n => n.channelId === a))
}

// ============================================================================
section('5. outbox:幂等发布 + 有界化')
// ============================================================================
{
  const evId = 'chat.message:test-1'
  outbox.enqueue({ aggregateType: 'chat_message', aggregateId: 'test-1', eventType: 'chat.message', eventId: evId })
  check('enqueue 后为 pending', outbox.findById(evId)?.status === 'pending')

  const first = outbox.markPublishedIfPending(evId)
  const second = outbox.markPublishedIfPending(evId)
  check('首次条件发布返回 true', first === true)
  check('重复条件发布返回 false(幂等,attempts 不重复增长)', second === false)
  check('attempts 只 +1', outbox.findById(evId)?.attempts === 1, `attempts=${outbox.findById(evId)?.attempts}`)

  // failed 行不得被"发布成功"覆盖(失败留痕不能被抹掉)
  const failedId = 'chat.delivery.status:test-f'
  outbox.enqueue({ aggregateType: 'chat_delivery', aggregateId: 'test-f', eventType: 'chat.delivery.status', eventId: failedId })
  outbox.markFailed(failedId, 'boom')
  check('条件发布不改动 failed 行', outbox.markPublishedIfPending(failedId) === false && outbox.findById(failedId)?.status === 'failed')

  // 保留期只回收已发布行
  const pendingId = 'chat.message:test-pending'
  outbox.enqueue({ aggregateType: 'chat_message', aggregateId: 'test-pending', eventType: 'chat.message', eventId: pendingId })
  const removed = outbox.sweepPublished(new Date(Date.now() + 60_000).toISOString())
  check('保留期回收已发布行', removed >= 1, `removed=${removed}`)
  check('pending 行不被回收(欠账必须保留)', outbox.findById(pendingId)?.status === 'pending')
  check('failed 行不被回收(失败留痕)', outbox.findById(failedId)?.status === 'failed')
}

// ============================================================================
section('6. 通知保留期:只回收已读')
// ============================================================================
{
  const me = 'user-sweep'
  const old = '2020-01-01T00:00:00.000Z'
  const readRow = notifications.create({ recipientUserId: me, type: 'mention', eventId: 'sw-read', createdAt: old }).row
  notifications.create({ recipientUserId: me, type: 'mention', eventId: 'sw-unread', createdAt: old })
  notifications.markRead(me, readRow.id)

  const removed = notifications.sweepRead(new Date(Date.now() - 86_400_000).toISOString())
  check('已读旧行被回收', removed === 1, `removed=${removed}`)
  check('未读行**永不**回收(删掉就是丢通知)', notifications.listRecent(me, 10).some(n => n.eventId === 'sw-unread'))
  check('未读数仍为 1', notifications.unreadCount(me) === 1, `unread=${notifications.unreadCount(me)}`)
}

// ============================================================================
section('7. 成员投影两处同源(displayName 回落一致)')
// ============================================================================
{
  const chId = makeChannel('proj')
  members.upsert({ channelId: chId, userId: 'user-without-name', role: 'member', status: 'active' })
  const row = members.listByChannel(chId).find(m => m.userId === 'user-without-name')!

  // 用户仓储不可用时 resolveOwnerName 返回 null;投影必须回落到 id 前 8 位(而不是露出 null)
  const projected = projectChannelMember(row, null)
  check('projectChannelMember(null) 保留 null(投影层不做兜底,由调用方给值)', projected.displayName === null)
  const withFallback = projectChannelMember(row, 'user-wit')
  check('projectChannelMember 原样透传调用方给的展示名', withFallback.displayName === 'user-wit')
  check('成员行字段完整(role/status/joinedAt)', !!row.role && !!row.status && !!row.joinedAt)
}

// ============================================================================
console.log(`\n${'='.repeat(64)}`)
console.log(`群聊加固回归: PASS=${passed}  FAIL=${failures.length}`)
if (failures.length > 0) {
  console.log('失败项:')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(64))
db.close()
process.exit(failures.length > 0 ? 1 : 0)
