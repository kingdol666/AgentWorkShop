/**
 * legacy 恢复保留的审计处置(repo 层):释放树标记 + 在飞消息按预算复位。
 * 不自动重放:任务状态不改动,重新执行必须走显式 retry/reopen。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-recovery-disposition-'))

const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { LEGACY_RECOVERY_MARKER } = await import('../server/services/workshop/runtime/task-engine/legacy-recovery')

function setup() {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(`INSERT INTO channels (id, name, created_at, updated_at) VALUES ('ch', 'disposition-test', '2026-01-01', '2026-01-01')`).run()
  const insertTask = db.prepare(`INSERT INTO tasks(id, channel_id, parent_id, root_queue_seq, assignee_id, title, state, close_reason, created_at, updated_at)
    VALUES (?, 'ch', ?, ?, 'worker', ?, 'WORKING', ?, '2026-01-01', '2026-01-01')`)
  // root R(held,带既有原因)+ 子任务 C(held)+ 无关 root R2(未 held)
  insertTask.run('R', null, 1, 'root', `previous reason ${LEGACY_RECOVERY_MARKER}`)
  insertTask.run('C', 'R', null, 'child', LEGACY_RECOVERY_MARKER)
  insertTask.run('R2', null, 2, 'unrelated', null)
  const insertMessage = db.prepare(`INSERT INTO messages(id, channel_id, task_id, to_agent_id, role, parts_json, metadata_json, state, attempts, claim_token, created_at)
    VALUES (?, 'ch', ?, 'worker', 'ROLE_USER', '[]', ?, ?, ?, ?, '2026-01-01')`)
  insertMessage.run('m-consume-low', 'R', '{}', 'consuming', 0, 'tok-1')
  insertMessage.run('m-consume-high', 'C', '{}', 'consuming', 3, 'tok-2')
  insertMessage.run('m-pending', 'R', '{}', 'pending', 0, null)
  insertMessage.run('m-dead', 'R', '{}', 'dead', 3, null)
  insertMessage.run('m-other', 'R2', '{}', 'consuming', 0, 'tok-3')
  const repo = createTaskRepo(db)
  return { db, repo }
}

test('处置释放整棵连接树的 hold,保留既有 close_reason,在飞消息按预算复位', () => {
  const { db, repo } = setup()
  const held = repo.listRecoveryHolds(LEGACY_RECOVERY_MARKER)
  assert.deepEqual(held.map(t => t.id).sort(), ['C', 'R'], 'hold 清单必须包含树成员且不含无关任务')
  const counts = repo.recoveryHoldMessageCounts('R')
  assert.deepEqual(counts, { pending: 1, consuming: 2, dead: 1 }, '树内消息计数(不含 R2 的消息)')

  const result = repo.disposeLegacyRecoveryHold('C', LEGACY_RECOVERY_MARKER)
  assert.ok(result, 'held 树的处置必须成功')
  assert.deepEqual(result.released.sort(), ['C', 'R'], '从子任务处置必须释放整棵树')
  assert.equal(result.requeued, 2, '两条 consuming 按预算复位')
  assert.equal(result.unblockedPending, 1, 'pending 联动消息恢复可投递(计数供审计)')

  const rowOf = (id: string) => db.prepare('SELECT close_reason AS closeReason, state FROM tasks WHERE id = ?').get(id) as { closeReason: string | null, state: string }
  assert.equal(rowOf('R').closeReason, 'previous reason', '既有 close_reason 内容必须保留,只清除 marker')
  assert.equal(rowOf('C').closeReason, null)
  assert.equal(rowOf('R2').closeReason, null)
  assert.equal(rowOf('R').state, 'WORKING', '任务状态不改动:不自动重放')
  const msgOf = (id: string) => db.prepare('SELECT state, attempts, claim_token AS claimToken FROM messages WHERE id = ?').get(id) as { state: string, attempts: number, claimToken: string | null }
  const mLow = msgOf('m-consume-low')
  assert.equal(mLow.state, 'pending', '预算内 consuming → pending')
  assert.equal(mLow.attempts, 0)
  assert.equal(mLow.claimToken, null)
  const mHigh = msgOf('m-consume-high')
  assert.equal(mHigh.state, 'dead', '预算耗尽 consuming → dead')
  assert.equal(mHigh.attempts, 3)
  assert.equal(mHigh.claimToken, null)
  const mOther = msgOf('m-other')
  assert.equal(mOther.state, 'consuming', '树外消息不得被触碰')
  assert.equal(mOther.claimToken, 'tok-3')

  assert.equal(repo.disposeLegacyRecoveryHold('C', LEGACY_RECOVERY_MARKER), null, '重复处置 → not-held')
  assert.deepEqual(repo.listRecoveryHolds(LEGACY_RECOVERY_MARKER), [], '处置后 hold 清单为空')
  db.close()
})

test('未 hold 任务与不存在任务的处置返回 null(不产生任何写入)', () => {
  const { db, repo } = setup()
  assert.equal(repo.disposeLegacyRecoveryHold('R2', LEGACY_RECOVERY_MARKER), null)
  assert.equal(repo.disposeLegacyRecoveryHold('missing', LEGACY_RECOVERY_MARKER), null)
  const m = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE state = \'pending\' AND claim_token IS NOT NULL').get() as { n: number }
  assert.equal(m.n, 0)
  db.close()
})
