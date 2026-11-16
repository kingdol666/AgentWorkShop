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

const { createMessageRepo, isRecoveryBlockedMessage } = await import('../server/services/workshop/db/message.repo')
const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')

function freshRepo() {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-guard', 'unconsumed-guard-test', new Date().toISOString(), new Date().toISOString())
  return { db, repo: createMessageRepo(db) }
}

/** 生产 claim 谓词口径:引用的任务不存在或被恢复 hold 即阻塞(runtime-wiring 同形)。 */
function productionClaimBlocked(db: InstanceType<typeof DatabaseSync>) {
  return (row: { taskId: string | null, metadataJson: string }) => isRecoveryBlockedMessage(row, (id) => {
    const held = db.prepare('SELECT close_reason FROM tasks WHERE id = ?').get(id) as { close_reason: string | null } | undefined
    return !held || (held.close_reason ?? '').includes('[LEGACY_EXECUTION_RECOVERY_REQUIRED]')
  })
}

test('pending 与 consuming 都算未消费完;consumed 后放行', () => {
  const { db, repo } = freshRepo()
  const m = repo.create({ channelId: 'ch-guard', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'work' }] })
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), true, 'pending 必须拦住卸载')
  const token = repo.claim(m.id)!
  assert.ok(token)
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), true, 'claim 后回合未开始也不能卸载')
  repo.markConsumed(m.id, token)
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

test('孤儿任务引用的消息不可投递,也不得永久阻塞空闲卸载(原始行保留为证据)', () => {
  const { db, repo } = freshRepo()
  const orphan = repo.create({
    channelId: 'ch-guard', taskId: 'task-gone', toAgentId: 'ag-1', role: 'ROLE_USER',
    parts: [{ text: 'assign' }], metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task-gone' },
  })
  // 生产 claim 谓词口径:任务不存在 → 该行永远不可投递(claim 永久过滤)
  assert.equal(repo.claim(orphan.id, productionClaimBlocked(db)), null, '孤儿引用必须被 claim 谓词过滤')
  // 旧计数把永远不可投递的行当活跃工作 → idle 卸载被永久阻塞(内存/omp 进程泄漏)
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), false, '孤儿引用不得阻塞卸载')
  // 原始行保留为证据,不自动处置用户数据
  const row = db.prepare('SELECT state, task_id, metadata_json AS metadataJson FROM messages WHERE id = ?').get(orphan.id) as { state: string, taskId: string, metadataJson: string }
  assert.equal(row.state, 'pending')
  db.close()
})

test('held 任务与无任务联动的消息仍阻塞卸载(孤儿豁免不得误伤)', () => {
  const { db, repo } = freshRepo()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO tasks (id, channel_id, assignee_id, title, state, created_at, updated_at, close_reason)
    VALUES ('task-held', 'ch-guard', 'ag-1', 'held', 'WORKING', ?, ?, '[LEGACY_EXECUTION_RECOVERY_REQUIRED]')`)
    .run(now, now)
  // held 任务的联动消息:暂时 claim 阻塞,任务闸(hasAssignedWork)兜底,计数必须保留
  repo.create({
    channelId: 'ch-guard', taskId: 'task-held', toAgentId: 'ag-1', role: 'ROLE_USER',
    parts: [{ text: 'assign' }], metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task-held' },
  })
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), true, 'held 联动消息仍算活跃')
  db.prepare('DELETE FROM messages').run()
  // 无任务联动的普通消息(taskId 指向已删任务但元数据无 task-kind)依旧可投递,必须阻塞卸载
  const plain = repo.create({ channelId: 'ch-guard', taskId: 'task-gone', toAgentId: 'ag-1', role: 'ROLE_USER', parts: [{ text: 'plain chat' }] })
  const token = repo.claim(plain.id, productionClaimBlocked(db))
  assert.ok(token, '无 task-kind 联动的行仍可投递')
  repo.releaseClaim(plain.id, token)
  assert.equal(repo.hasUnconsumedByChannelAgent('ch-guard', 'ag-1'), true, '可投递的消息必须阻塞卸载')
  db.close()
})
