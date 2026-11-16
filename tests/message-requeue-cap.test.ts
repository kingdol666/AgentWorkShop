/**
 * P3-4(2026-11-01):steer 失败重投上限回归。
 * requeue:attempts+1,达 3 次 → state='dead'(永不再投);崩溃恢复 resetConsuming
 * 不复活 dead;健康消息重投两次内正常回 pending。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const { createMessageRepo, isRecoveryBlockedMessage } = await import('../server/services/workshop/db/message.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { TaskEngine } = await import('../server/services/workshop/runtime/task-engine/facade')
const { Mailbox } = await import('../server/services/workshop/runtime/mailbox')
const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')

function freshRepo() {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  // messages.channel_id → channels(id) FK:先种一条频道行
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-fix', 'requeue-cap-test', new Date().toISOString(), new Date().toISOString())
  return { db, repo: createMessageRepo(db) }
}

test('releaseClaim is conditional and preserves the retry budget', () => {
  const { db, repo } = freshRepo()
  try {
    const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    assert.equal(repo.releaseClaim(m.id, 'missing'), false)
    const first = repo.claim(m.id)!
    assert.ok(first)
    assert.equal(repo.requeue(m.id, first), true)
    const second = repo.claim(m.id)!
    assert.ok(second)
    assert.notEqual(first, second)
    assert.equal(repo.releaseClaim(m.id, second), true)
    assert.equal(repo.releaseClaim(m.id, second), false)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts FROM messages WHERE id = ?').get(m.id) }, { state: 'pending', attempts: 1 })
    const third = repo.claim(m.id)!
    assert.ok(third)
    repo.markConsumed(m.id, third)
    assert.equal(repo.releaseClaim(m.id, third), false)
  }
  finally {
    db.close()
  }
})

test('Mailbox restores session metadata from non-object JSON after claim', async () => {
  const { db, repo } = freshRepo()
  try {
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {})
    for (const [index, json] of ['null', '[]', '"text"', '42', 'false', '{bad', '{"keep":1}', '{"x-aw-session-id":"existing"}'].entries()) {
      const message = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
      db.prepare('UPDATE messages SET metadata_json = ?, session_id = ? WHERE id = ?').run(json, 'session-1', message.id)
      const delivery = await box.dequeue()
      assert.ok(delivery)
      const expected: Record<string, unknown> = { 'x-aw-session-id': index === 7 ? 'existing' : 'session-1' }
      if (index === 6) expected.keep = 1
      assert.deepEqual(delivery.metadata, expected)
      const token = box.claimToken(delivery)
      assert.ok(token)
      assert.equal(box.markConsumed(message.id, token), true)
    }
  }
  finally { db.close() }
})

test('Mailbox stop release returns only claims that never entered processing', async () => {
  const { db, repo } = freshRepo()
  try {
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {})
    const first = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'first' }] })
    const second = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'second' }] })
    const firstDelivery = (await box.dequeue())!
    assert.equal(firstDelivery.messageId, first.id)
    const firstToken = box.claimToken(firstDelivery)!
    assert.equal(box.beginProcessing(first.id, firstToken), true)
    assert.equal((await box.dequeue())?.messageId, second.id)
    assert.equal(box.releaseOwnedClaims(), 1)
    const rows = db.prepare('SELECT id, state FROM messages WHERE id IN (?, ?) ORDER BY rowid').all(first.id, second.id) as Array<{ id: string, state: string }>
    assert.deepEqual(rows.map(row => row.state), ['consuming', 'pending'])
    assert.equal(box.releaseClaim(first.id, firstToken), true, 'processing claim can be released after its turn stops')
  }
  finally {
    db.close()
  }
})

test('P3-4: requeue 三次后 dead,resetConsuming 不复活', () => {
  const { db, repo } = freshRepo()
  const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'poison' }] })
  assert.equal(repo.requeue(m.id, repo.claim(m.id)!), true, '第 1 次重投 → pending')
  assert.equal(repo.requeue(m.id, repo.claim(m.id)!), true, '第 2 次重投 → pending')
  assert.equal(repo.requeue(m.id, repo.claim(m.id)!), true, '第 3 次重投返回 true(行更新为 dead)')
  const dead = db.prepare('SELECT state, attempts FROM messages WHERE id = ?').get(m.id) as { state: string, attempts: number }
  assert.equal(dead.state, 'dead', '达 3 次 → dead')
  assert.equal(dead.attempts, 3)
  const queue = repo.listPendingByChannelAgent('ch-fix', 'ag-1')
  assert.equal(queue.length, 0, 'dead 消息不回队列')
  repo.resetConsuming()
  const after = db.prepare('SELECT state FROM messages WHERE id = ?').get(m.id) as { state: string }
  assert.equal(after.state, 'dead', '重启重投不洗白 dead')
})

test('P3-4: 健康消息两次重投内保持 pending 可继续消费', () => {
  const { repo } = freshRepo()
  const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'normal' }] })
  assert.equal(repo.requeue(m.id, repo.claim(m.id)!), true)
  const again = repo.listPendingByChannelAgent('ch-fix', 'ag-1')
  assert.equal(again.length, 1, '未达上限 → 回队列')
  assert.equal(again[0]!.attempts, 1)
})

test('P0:requeue 后迟到的 markConsumed 不得吞掉重投消息', () => {
  const { db, repo } = freshRepo()
  const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'late' }] })
  const token = repo.claim(m.id)!
  assert.ok(token)
  assert.equal(repo.requeue(m.id, token), true)
  // 旧实现无条件 UPDATE ... WHERE id=?, 会把 pending 行改成 consumed(消息丢失)。
  repo.markConsumed(m.id, token)
  const row = db.prepare('SELECT state FROM messages WHERE id = ?').get(m.id) as { state: string }
  assert.equal(row.state, 'pending', '迟到消费必须 no-op,消息保留在重投队列')
  assert.equal(repo.listPendingByChannelAgent('ch-fix', 'ag-1').length, 1)
})

test('stale tokens cannot settle a newer claim, including after reset', () => {
  const { db, repo } = freshRepo()
  try {
    const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    const old = repo.claim(m.id)!
    assert.equal(repo.requeue(m.id, old), true)
    const current = repo.claim(m.id)!
    assert.notEqual(current, old)
    assert.equal(repo.releaseClaim(m.id, old), false)
    assert.equal(repo.requeue(m.id, old), false)
    assert.equal(repo.markConsumed(m.id, old), false)
    assert.equal(repo.markConsumed(m.id, undefined as unknown as string), false)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, claim_token AS token FROM messages WHERE id = ?').get(m.id) },
      { state: 'consuming', attempts: 1, token: current })
    repo.resetConsuming()
    assert.equal((db.prepare('SELECT claim_token FROM messages WHERE id = ?').get(m.id) as { claim_token: string | null }).claim_token, null)
    const afterReset = repo.claim(m.id)!
    assert.notEqual(afterReset, current)
    assert.equal(repo.releaseClaim(m.id, current), false)
    assert.equal(repo.markConsumed(m.id, afterReset), true)
    assert.equal((db.prepare('SELECT claim_token FROM messages WHERE id = ?').get(m.id) as { claim_token: string | null }).claim_token, null)
  }
  finally { db.close() }
})

test('stale mailbox cleanup cannot release a claim owned by another mailbox', async () => {
  const { db, repo } = freshRepo()
  try {
    const first = new Mailbox(repo, 'ch-fix', 'ag-1', () => {})
    const second = new Mailbox(repo, 'ch-fix', 'ag-1', () => {})
    const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    const delivery = (await first.dequeue())!
    const old = first.claimToken(delivery)!
    repo.resetConsuming()
    const current = second.claimToken((await second.dequeue())!)!
    assert.notEqual(old, current)
    assert.equal(first.releaseOwnedClaims(), 0)
    assert.equal(first.releaseClaim(m.id, old), false)
    assert.equal(second.ownsClaim(m.id, current), true)
    assert.equal(second.markConsumed(m.id, current), true)
  }
  finally { db.close() }
})

test('same mailbox keeps separate claim generations and rejects stale settlement', async () => {
  const { db, repo } = freshRepo()
  try {
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {})
    const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    const oldDelivery = (await box.dequeue())!
    const old = box.claimToken(oldDelivery)!
    assert.ok(old)
    assert.equal(JSON.stringify(oldDelivery).includes(old), false, 'claim token must not enter the message payload')
    assert.equal(box.beginProcessing(m.id, old), true)
    repo.resetConsuming()
    const newDelivery = (await box.dequeue())!
    const current = box.claimToken(newDelivery)!
    assert.notEqual(old, current)
    assert.equal(box.releaseClaim(m.id, old), false)
    assert.equal(box.requeue(m.id, old), false)
    assert.equal(box.markConsumed(m.id, old), false)
    assert.equal(box.beginProcessing(m.id, current), true)
    assert.equal(box.releaseOwnedClaims(), 0)
    assert.equal(box.releaseClaim(m.id, current), true)
    assert.equal((db.prepare('SELECT state FROM messages WHERE id = ?').get(m.id) as { state: string }).state, 'pending')
  }
  finally { db.close() }
})

function insertRecoveryTask(db: DatabaseSync, id: string, held: boolean): void {
  db.prepare(`INSERT INTO tasks (id, channel_id, assignee_id, title, state, close_reason, created_at, updated_at)
    VALUES (?, 'ch-fix', 'ag-1', ?, 'WORKING', ?, '2026-01-01', '2026-01-01')`)
    .run(id, id, held ? '[LEGACY_EXECUTION_RECOVERY_REQUIRED]' : null)
}

test('recovery dead-letter requires an exact current token and preserves retry attempts', () => {
  const { db, repo } = freshRepo()
  try {
    insertRecoveryTask(db, 'held', true)
    const m = repo.create({ channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': 'assign' } })
    const first = repo.claim(m.id)!
    assert.equal(repo.requeue(m.id, first), true)
    assert.equal(repo.deadLetterLegacyRecoveryClaim(m.id, first), false, 'pending cannot be settled by a stale owner')
    assert.equal(repo.deadLetterLegacyRecoveryClaim(m.id, ''), false)
    assert.equal(repo.deadLetterLegacyRecoveryClaim(m.id, undefined as unknown as string), false)
    const current = repo.claim(m.id)!
    assert.notEqual(current, first)
    assert.equal(repo.deadLetterLegacyRecoveryClaim(m.id, first), false)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, claim_token AS token FROM messages WHERE id = ?').get(m.id) },
      { state: 'consuming', attempts: 1, token: current })
    assert.equal(repo.deadLetterLegacyRecoveryClaim(m.id, current), true)
    assert.equal(repo.deadLetterLegacyRecoveryClaim(m.id, current), false)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, claim_token AS token, consumed_at AS consumedAt FROM messages WHERE id = ?').get(m.id) },
      { state: 'dead', attempts: 1, token: null, consumedAt: null })
    repo.resetConsuming()
    assert.equal(db.prepare('SELECT state FROM messages WHERE id = ?').get(m.id)?.state, 'dead')
  }
  finally { db.close() }
})

test('recovery dead-letter matches task, metadata task, and child references without touching chat', () => {
  const { db, repo } = freshRepo()
  try {
    insertRecoveryTask(db, 'held', true)
    insertRecoveryTask(db, 'healthy', false)
    const cases = [
      { id: 'column', taskId: 'held', metadata: { 'x-aw-task-kind': 'cancel' }, dead: true },
      { id: 'metadata', taskId: null, metadata: { 'x-aw-task-kind': 'child-completed', 'x-aw-task-id': 'held' }, dead: true },
      { id: 'child', taskId: 'healthy', metadata: { 'x-aw-task-kind': 'guide', 'x-aw-child-task-id': 'held' }, dead: true },
      { id: 'chat', taskId: 'held', metadata: { 'x-aw-task-id': 'held' }, dead: false },
      { id: 'healthy', taskId: 'healthy', metadata: { 'x-aw-task-kind': 'assign' }, dead: false },
      { id: 'missing', taskId: null, metadata: { 'x-aw-task-kind': 'assign' }, dead: false },
    ]
    for (const item of cases) {
      repo.create({ id: item.id, channelId: 'ch-fix', taskId: item.taskId, toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata: item.metadata })
      const token = repo.claim(item.id)!
      assert.equal(repo.deadLetterLegacyRecoveryClaim(item.id, token), item.dead, item.id)
      assert.equal(db.prepare('SELECT state FROM messages WHERE id = ?').get(item.id)?.state, item.dead ? 'dead' : 'consuming')
      if (!item.dead) assert.equal(repo.releaseClaim(item.id, token), true)
    }
    const malformed = repo.create({ id: 'malformed', channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    db.prepare('UPDATE messages SET metadata_json = ?, attempts = 2 WHERE id = ?').run('{', malformed.id)
    const token = repo.claim(malformed.id)!
    assert.equal(repo.deadLetterLegacyRecoveryClaim(malformed.id, token), true)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, metadata_json AS metadata, claim_token AS token FROM messages WHERE id = ?').get(malformed.id) },
      { state: 'dead', attempts: 2, metadata: '{', token: null })
  }
  finally { db.close() }
})

test('mailbox recovery dead-letter cleans only its exact ownership and retains unmatched claims', async () => {
  const { db, repo } = freshRepo()
  try {
    insertRecoveryTask(db, 'held', true)
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {})
    const m = repo.create({ channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': 'assign' } })
    const old = box.claimToken((await box.dequeue())!)!
    assert.equal(box.beginProcessing(m.id, old), true)
    repo.resetConsuming()
    const current = box.claimToken((await box.dequeue())!)!
    assert.notEqual(current, old)
    assert.equal(box.deadLetterLegacyRecoveryClaim(m.id, old), false)
    assert.equal(box.ownsClaim(m.id, current), true)
    assert.equal(box.beginProcessing(m.id, current), true)
    assert.equal(box.deadLetterLegacyRecoveryClaim(m.id, current), true)
    assert.equal(box.releaseOwnedClaims(), 0)
    assert.equal(box.markConsumed(m.id, current), false)
    assert.equal(box.releaseClaim(m.id, old), false)

    const chat = repo.create({ channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    const chatToken = box.claimToken((await box.dequeue())!)!
    assert.equal(box.deadLetterLegacyRecoveryClaim(chat.id, chatToken), false)
    assert.equal(box.ownsClaim(chat.id, chatToken), true)
    assert.equal(box.releaseOwnedClaims(), 1)
    assert.equal(db.prepare('SELECT state FROM messages WHERE id = ?').get(chat.id)?.state, 'pending')
    assert.equal(repo.markConsumed(chat.id, repo.claim(chat.id)!), true)

    const releasedHold = repo.create({ channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': 'assign' } })
    const heldToken = box.claimToken((await box.dequeue())!)!
    assert.equal(box.beginProcessing(releasedHold.id, heldToken), true)
    db.prepare('UPDATE tasks SET close_reason = NULL WHERE id = ?').run('held')
    assert.equal(box.deadLetterLegacyRecoveryClaim(releasedHold.id, heldToken), false)
    assert.equal(box.ownsClaim(releasedHold.id, heldToken), true)
    assert.equal(box.markConsumed(releasedHold.id, heldToken), true)
  }
  finally { db.close() }
})

test('eligibility skips blocked task messages but keeps chat and FIFO across peek, dequeue and direct claim', async () => {
  const { db, repo } = freshRepo()
  try {
    const insert = db.prepare(`INSERT INTO tasks (id, channel_id, assignee_id, title, state, root_queue_seq, close_reason, created_at, updated_at)
      VALUES (?, 'ch-fix', 'ag-1', ?, 'WORKING', ?, ?, '2026-01-01', '2026-01-01')`)
    insert.run('earlier', 'earlier', 1, null)
    insert.run('held', 'held', 2, '[LEGACY_EXECUTION_RECOVERY_REQUIRED]')
    insert.run('later', 'later', 3, null)
    const engine = new TaskEngine({ tasks: createTaskRepo(db), messages: repo })
    const blocked = (row: Parameters<typeof isRecoveryBlockedMessage>[0]) => isRecoveryBlockedMessage(row, id => engine.isLegacyRecoveryBlocked(id))
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {}, blocked)
    const create = (id: string, taskId: string | null, metadata: Record<string, unknown>) => repo.create({
      id, channelId: 'ch-fix', taskId, toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata,
    })
    create('blocked-first', 'later', { 'x-aw-task-kind': 'assign' })
    create('metadata-blocked', null, { 'x-aw-task-kind': 'guide', 'x-aw-task-id': 'later' })
    create('chat', 'held', { 'x-aw-task-id': 'held' })
    create('child-blocked', 'earlier', { 'x-aw-task-kind': 'child-completed', 'x-aw-child-task-id': 'held' })
    create('earlier-task', 'earlier', { 'x-aw-task-kind': 'assign' })
    create('chat-second', null, {})
    assert.deepEqual((await box.peek(2)).map(m => m.messageId), ['chat', 'earlier-task'])
    assert.deepEqual(repo.listPendingByChannelAgent('ch-fix', 'ag-1', 2, blocked).map(m => m.id), ['chat', 'earlier-task'])
    assert.equal(box.claim('blocked-first'), null, 'steer claim must not bypass eligibility')
    assert.equal(repo.claim('metadata-blocked', blocked), null, 'direct ack claim must not bypass eligibility')
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, claim_token AS token FROM messages WHERE id = ?').get('blocked-first') },
      { state: 'pending', attempts: 0, token: null })
    for (const id of ['chat', 'earlier-task', 'chat-second']) {
      const delivery = (await box.dequeue())!
      assert.equal(delivery.messageId, id)
      assert.equal(box.markConsumed(id, box.claimToken(delivery)!), true)
    }
    assert.deepEqual(await box.peek(5), [])
    assert.equal(repo.listPendingByChannelAgent('ch-fix', 'ag-1').length, 3)
    box.close()
  }
  finally { db.close() }
})

test('wake rechecks blocked messages and notifies arrival waiters without changing attempts', async () => {
  const { db, repo } = freshRepo()
  try {
    let blockedTask = true
    const blocked = (row: Parameters<typeof isRecoveryBlockedMessage>[0]) => isRecoveryBlockedMessage(row, () => blockedTask)
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {}, blocked)
    const m = repo.create({ channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': 'assign' } })
    const waiting = box.dequeue()
    let arrived = 0
    const unsubscribe = box.onArrival(() => {
      arrived++
    })
    assert.deepEqual(await box.peek(1), [])
    assert.equal(box.claim(m.id), null)
    blockedTask = false
    box.wake()
    assert.equal(arrived, 1)
    const delivery = await waiting
    assert.equal(delivery?.messageId, m.id)
    assert.equal(box.markConsumed(m.id, box.claimToken(delivery!)!), true)
    assert.equal(db.prepare('SELECT attempts FROM messages WHERE id = ?').get(m.id)?.attempts, 0)
    unsubscribe()
    box.close()
  }
  finally { db.close() }
})

test('processing claim rechecks the raw row and rejects stale tokens', async () => {
  const { db, repo } = freshRepo()
  try {
    let blocked = false
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {}, row => blocked && row.metadataJson === '{broken')
    const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [] })
    db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run('{broken', m.id)
    const delivery = (await box.dequeue())!
    const old = box.claimToken(delivery)!
    assert.deepEqual(delivery.metadata, {})
    assert.equal(box.beginProcessing(m.id, old), true)
    assert.equal(box.isClaimBlocked(m.id, old), false)
    blocked = true
    assert.equal(box.isClaimBlocked(m.id, old), true)
    assert.equal(box.releaseClaim(m.id, old), true)
    blocked = false
    const current = box.claimToken((await box.dequeue())!)!
    assert.notEqual(current, old)
    assert.equal(box.isClaimBlocked(m.id, old), true)
    assert.equal(box.isClaimBlocked(m.id, current), false)
    assert.equal(box.releaseClaim(m.id, old), false)
    assert.equal(box.ownsClaim(m.id, current), true)
    assert.equal(box.releaseClaim(m.id, current), true)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts FROM messages WHERE id = ?').get(m.id) }, { state: 'pending', attempts: 0 })
    box.close()
  }
  finally { db.close() }
})

test('claim and processing recheck eligibility without charging attempts or losing ownership', async () => {
  const { db, repo } = freshRepo()
  try {
    let blockedTask = false
    const blocked = (row: Parameters<typeof isRecoveryBlockedMessage>[0]) => isRecoveryBlockedMessage(row, () => blockedTask)
    const box = new Mailbox(repo, 'ch-fix', 'ag-1', () => {}, blocked)
    const m = repo.create({ channelId: 'ch-fix', taskId: 'held', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': 'assign' } })
    const delivery = (await box.dequeue())!
    const token = box.claimToken(delivery)!
    blockedTask = true
    assert.equal(box.beginProcessing(m.id, token), false)
    assert.equal(box.ownsClaim(m.id, token), false)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, claim_token AS token FROM messages WHERE id = ?').get(m.id) },
      { state: 'pending', attempts: 0, token: null })
    let calls = 0
    const flipsOnClaim = () => ++calls > 1
    assert.equal(repo.claim(m.id, flipsOnClaim), null)
    assert.equal(calls, 2)
    assert.deepEqual({ ...db.prepare('SELECT state, attempts, claim_token AS token FROM messages WHERE id = ?').get(m.id) },
      { state: 'pending', attempts: 0, token: null })
    assert.equal(repo.claim(m.id, () => {
      throw new Error('unavailable')
    }), null)
    box.close()
  }
  finally { db.close() }
})
