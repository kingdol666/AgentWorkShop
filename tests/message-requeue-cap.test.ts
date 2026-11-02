/**
 * P3-4(2026-11-01):steer 失败重投上限回归。
 * requeue:attempts+1,达 3 次 → state='dead'(永不再投);崩溃恢复 resetConsuming
 * 不复活 dead;健康消息重投两次内正常回 pending。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')

function freshRepo() {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  // messages.channel_id → channels(id) FK:先种一条频道行
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-fix', 'requeue-cap-test', new Date().toISOString(), new Date().toISOString())
  return { db, repo: createMessageRepo(db) }
}

test('P3-4: requeue 三次后 dead,resetConsuming 不复活', () => {
  const { db, repo } = freshRepo()
  const m = repo.create({ channelId: 'ch-fix', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'poison' }] })
  repo.claim(m.id)
  assert.equal(repo.requeue(m.id), true, '第 1 次重投 → pending')
  repo.claim(m.id)
  assert.equal(repo.requeue(m.id), true, '第 2 次重投 → pending')
  repo.claim(m.id)
  assert.equal(repo.requeue(m.id), true, '第 3 次重投返回 true(行更新为 dead)')
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
  repo.claim(m.id)
  assert.equal(repo.requeue(m.id), true)
  const again = repo.listPendingByChannelAgent('ch-fix', 'ag-1')
  assert.equal(again.length, 1, '未达上限 → 回队列')
  assert.equal(again[0]!.attempts, 1)
})
