/**
 * 运行时卸载/配置重装闸门必须把 consuming 也算作「未消费完」。
 *
 * 回归场景:消息 POST 后消费循环 claim 成功(pending→consuming),但回合真正开始前
 * runtime 状态仍是 idle。旧闸门只查 pending,会在该窗口把运行时连同消息一起卸载,
 * 消息滞留到停滞看门狗(实测 10min)。hasUnconsumed 覆盖 pending+consuming。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')

function freshRepo() {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-guard', 'unconsumed-guard-test', new Date().toISOString(), new Date().toISOString())
  return { db, repo: createMessageRepo(db) }
}

test('pending 与 consuming 都算未消费完;consumed 后放行', () => {
  const { db, repo } = freshRepo()
  const m = repo.create({ channelId: 'ch-guard', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'work' }] })
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), true, 'pending 必须拦住卸载')
  assert.equal(repo.claim(m.id), true)
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), true, 'claim 后回合未开始也不能卸载')
  repo.markConsumed(m.id)
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), false, '消费完成后允许卸载')
  db.close()
})

test('其他 Agent 的消息不影响本 Agent 的卸载判定', () => {
  const { db, repo } = freshRepo()
  repo.create({ channelId: 'ch-guard', toAgentId: 'ag-2', role: 'ROLE_USER', parts: [{ text: 'other' }] })
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), false)
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-2'), true)
  db.close()
})
