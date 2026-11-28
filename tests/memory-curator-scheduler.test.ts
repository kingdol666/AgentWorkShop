/**
 * Phase 6：Curator 调度卫生。
 * - 单飞：第一轮未结束时第二轮直接返回 []；
 * - stale running run 回收；
 * - stop 可重复调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-curator-sched-'))
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_CURATOR_DISABLED

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { startCuratorScheduler, reconcileStaleCurationRuns } = await import('../server/services/workshop/memory/curator/scheduler')

const db = openWorkshopDb(':memory:')
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','注塑一线','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)

test('scheduler is single-flight and stoppable', async () => {
  const scheduler = startCuratorScheduler(db, { intervalMs: 60_000, initialDelayMs: 0, sweepLimit: 1 })
  assert.ok(scheduler)
  const first = scheduler.runOnce()
  const second = await scheduler.runOnce()
  assert.deepEqual(second, [], '第一轮未结束时第二轮必须直接返回空')
  await first
  scheduler.stop()
  scheduler.stop()
})

test('stale curation runs are reclaimed', () => {
  db.prepare(`INSERT INTO memory_curation_runs(id, channel_id, mode, status, started_at)
    VALUES ('cur-stale','c1','template','running',?)`).run(new Date(Date.now() - 2 * 3600_000).toISOString())
  assert.equal(reconcileStaleCurationRuns(db), 1)
  const row = db.prepare(`SELECT status, error FROM memory_curation_runs WHERE id = 'cur-stale'`).get() as { status: string, error: string }
  assert.equal(row.status, 'failed')
  assert.equal(row.error, 'stale_run')
})
