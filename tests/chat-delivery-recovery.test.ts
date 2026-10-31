/**
 * chat 投递崩溃恢复(整改计划 2026-10-30 阶段2)仓储语义:
 *   - listRetryableDeliveries 只取「pending 且 mailbox 未落库且到期」的投递
 *   - bumpDeliveryRetry 记次 + 退避排程;markDeliveryDead 只转 pending,超限死信可见
 *   - buildMessage 显式 id 透传(确定性消息 id = 崩溃重投去重锚)
 * 全 manager 故障注入(进程级崩溃窗口)由隔离实例 e2e 覆盖;此处锁定台账语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChatMessageRepo } from '../server/services/workshop/db/chat-message.repo'
import { buildMessage } from '../server/services/workshop/runtime/manager/helpers'

function harness() {
  const db = openWorkshopDb(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-1', '投递恢复测试频道', now, now)
  const repo = createChatMessageRepo(db)
  return { db, repo }
}

function seedPendingDelivery(repo: ReturnType<typeof createChatMessageRepo>, opts: { target?: string } = {}) {
  const msg = repo.create({
    channelId: 'ch-1',
    senderType: 'user',
    senderId: 'user-1',
    senderName: '验收员',
    text: '@worker 请抓取最新数采',
    requesterUserId: 'user-1',
  })
  const delivery = repo.createDelivery({
    chatMessageId: msg.row.id,
    channelId: 'ch-1',
    targetAgentId: opts.target ?? 'agent-1',
    status: 'pending',
  })
  return { message: msg.row, delivery: delivery.row }
}

test('恢复扫描:只取 pending+mailbox 未落库+到期的投递', () => {
  const { repo } = harness()
  const { delivery } = seedPendingDelivery(repo)
  const rows = repo.listRetryableDeliveries(new Date().toISOString(), 50)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, delivery.id)
  assert.equal(rows[0]!.attempts, 0)
})

test('退避未到期的投递不进扫描;到期后重新可见', () => {
  const { repo } = harness()
  const { delivery } = seedPendingDelivery(repo)
  const future = new Date(Date.now() + 60_000).toISOString()
  repo.bumpDeliveryRetry(delivery.id, future)
  assert.equal(repo.listRetryableDeliveries(new Date().toISOString(), 50).length, 0)
  const past = new Date(Date.now() - 1000).toISOString()
  repo.bumpDeliveryRetry(delivery.id, past)
  const rows = repo.listRetryableDeliveries(new Date().toISOString(), 50)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.attempts, 2)
})

test('重试超限转死信:failed 不再进扫描且错误可读', () => {
  const { repo } = harness()
  const { delivery } = seedPendingDelivery(repo)
  for (let i = 0; i < 5; i++) repo.bumpDeliveryRetry(delivery.id, new Date(Date.now() - 1000).toISOString())
  const dead = repo.markDeliveryDead(delivery.id, '投递重试 5 次仍未落 mailbox,转死信')
  assert.equal(dead, true)
  assert.equal(repo.listRetryableDeliveries(new Date().toISOString(), 50).length, 0)
  const row = repo.findDeliveryById(delivery.id)
  assert.equal(row?.status, 'failed')
  assert.match(row?.error ?? '', /死信/)
})

test('已投递(delivered)的投递不进恢复扫描(第二窗口不重投语义)', () => {
  const { repo } = harness()
  const { message, delivery } = seedPendingDelivery(repo)
  repo.updateDeliveryStatus(message.id, delivery.targetAgentId, 'delivered', { mailboxMessageId: 'dlv-x' })
  assert.equal(repo.listRetryableDeliveries(new Date().toISOString(), 50).length, 0)
})

test('buildMessage 显式 id 透传(确定性 mailbox 消息 id 锚)', () => {
  const msg = buildMessage('ch-1', 'ROLE_USER', [{ text: 'hi' }], {}, 'dlv-fixed-id')
  assert.equal(msg.messageId, 'dlv-fixed-id')
  const auto = buildMessage('ch-1', 'ROLE_USER', [{ text: 'hi' }], {})
  assert.ok(auto.messageId && auto.messageId !== 'dlv-fixed-id')
})
