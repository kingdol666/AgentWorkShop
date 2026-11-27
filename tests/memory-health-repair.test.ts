/**
 * Phase 6：健康/修复（M36）。
 * - 记忆/实体 FTS 行数可检测；
 * - repair 真正重建 FTS、回收 stale graph run；
 * - 图谱统计/待合并进入健康面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-graph-health-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { memoryHealth, repairMemory } = await import('../server/services/workshop/memory/export')
const { createMemoryGraphRepo } = await import('../server/services/workshop/memory/graph/repo')

const db = openWorkshopDb(':memory:')
const now = new Date().toISOString()

interface HealthView {
  ftsHealthy: boolean
  graph: { entityFtsHealthy: boolean, staleRuns: number }
}
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','注塑一线','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
db.prepare(`INSERT INTO agent_memories(id, channel_id, agent_id, kind, title, title_fts, content, importance,
    session_id, dedup_key, scope_kind, scope_key, status, created_at, updated_at)
  VALUES ('m1','c1','a1','semantic','保压经验','保 压 经 验','保压压力 60→62',0.7,'','sem:m1','channel','','active',?,?)`)
  .run(now, now)

test('health detects FTS loss; repair rebuilds memory/entity FTS', () => {
  const repo = createMemoryGraphRepo(db)
  repo.upsertEntity({ channelId: 'c1', entityType: 'parameter', canonicalName: '保压压力' })
  const before = memoryHealth(db, 'c1') as unknown as HealthView
  assert.equal(before.ftsHealthy, true)
  assert.equal(before.graph.entityFtsHealthy, true)

  db.prepare('DELETE FROM agent_memories_fts').run()
  db.prepare('DELETE FROM memory_entities_fts').run()
  const broken = memoryHealth(db, 'c1') as unknown as HealthView
  assert.equal(broken.ftsHealthy, false)
  assert.equal(broken.graph.entityFtsHealthy, false)

  const counts = repairMemory(db)
  assert.ok(counts.memoryFtsRebuilt >= 1)
  assert.ok(counts.entityFtsRebuilt >= 1)
  const after = memoryHealth(db, 'c1') as unknown as HealthView
  assert.equal(after.ftsHealthy, true)
  assert.equal(after.graph.entityFtsHealthy, true)
})

test('health surfaces stale graph runs; repair reclaims them', () => {
  const repo = createMemoryGraphRepo(db)
  const runId = repo.startRun('c1', 'incremental')
  db.prepare('UPDATE memory_graph_runs SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 2 * 3600_000).toISOString(), runId)
  const before = memoryHealth(db, 'c1') as unknown as HealthView
  assert.ok(before.graph.staleRuns >= 1)
  repairMemory(db)
  const after = memoryHealth(db, 'c1') as unknown as HealthView
  assert.equal(after.graph.staleRuns, 0)
})
