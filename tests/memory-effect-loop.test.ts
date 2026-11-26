/**
 * 批次 H：效果归因与保守自动退役（M23–M26）。
 * - 任务终态按 task 只计一次；
 * - channel 经验 uses≥8 且失败率≥0.6 → withdrawn；
 * - line/product 只 flag，不撤；
 * - 人工恢复后 30 天内不再自动退役；
 * - 不自动晋升任何 candidate。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-effect-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { recordMemoryInjection, attributeMemoryInjection, markMemoryRestored } = await import('../server/services/workshop/memory/effect')
const { getVersion } = await import('../server/services/workshop/experience/versions')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'effect.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','C1','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
const repo = createMemoryRepo(db)

function experience(scopeKind: 'channel' | 'line' | 'product', key: string, dedup: string) {
  const id = repo.upsertExperience({
    channelId: 'c1', agentId: 'a1', kind: 'experience', title: `经验 ${dedup}`,
    titleFts: `经 验 ${dedup}`, content: '经验正文', importance: 0.7, dedupKey: dedup,
    evidence: { taskIds: ['t-seed'] }, scopeKind, scopeKey: key, status: 'validated',
  }).id
  const versionId = `ev-${dedup}`
  db.prepare(`INSERT INTO experience_versions
    (version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content, content_hash,
     evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', '经验正文', ?, '[]', ?, 'validated', 'active', ?, '[]', ?, ?)`)
    .run(versionId, id, `co-${dedup}`, scopeKind, key, `h-${dedup}`, `eh-${dedup}`, now, `idem-${dedup}`, now)
  db.prepare(`INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES (?, ?, ?)`).run(id, versionId, now)
  return { id, versionId }
}

function attributeFailures(memoryId: string, prefix: string, count: number) {
  for (let i = 0; i < count; i++) {
    const taskId = `${prefix}-${memoryId}-${i}`
    recordMemoryInjection(db, {
      channelId: 'c1', agentId: 'a1', sessionId: 's1', taskId,
      refs: [{ id: memoryId, kind: 'experience', source: 'primer' }],
    })
    attributeMemoryInjection(db, taskId, false)
  }
}

test('channel experience retires after 8 uses / 60%+ failures', () => {
  const channelExp = experience('channel', '', 'exp-channel')
  attributeFailures(channelExp.id, 't', 8)
  const row = db.prepare('SELECT uses, failures FROM memory_effect_stats WHERE memory_id = ?').get(channelExp.id) as { uses: number, failures: number }
  assert.equal(row.uses, 8)
  assert.equal(row.failures, 8)
  assert.equal(getVersion(db, channelExp.versionId)?.deployment, 'withdrawn')
})

test('line/product experience is flagged, not withdrawn', () => {
  const lineExp = experience('line', 'L1', 'exp-line')
  attributeFailures(lineExp.id, 'tl', 8)
  const stats = db.prepare('SELECT uses, failures, flagged FROM memory_effect_stats WHERE memory_id = ?').get(lineExp.id) as { uses: number, failures: number, flagged: number }
  assert.equal(stats.uses, 8)
  assert.equal(stats.flagged, 1)
  assert.equal(getVersion(db, lineExp.versionId)?.deployment, 'active', 'line/product 只 flag 不撤')
})

test('repeated terminal for same task does not double count', () => {
  const exp = experience('channel', '', 'exp-idem')
  const ref = { id: exp.id, kind: 'experience', source: 'primer' as const }
  recordMemoryInjection(db, { channelId: 'c1', agentId: 'a1', taskId: 'same-task', refs: [ref] })
  attributeMemoryInjection(db, 'same-task', false)
  attributeMemoryInjection(db, 'same-task', false)
  attributeMemoryInjection(db, 'same-task', true)
  const stats = db.prepare('SELECT uses, failures, successes FROM memory_effect_stats WHERE memory_id = ?').get(exp.id) as { uses: number, failures: number, successes: number }
  assert.equal(stats.uses, 1)
  assert.equal(stats.failures, 1)
  assert.equal(stats.successes, 0)
})

test('human restore exempts auto-retire for 30 days', () => {
  const exp = experience('channel', '', 'exp-restored')
  attributeFailures(exp.id, 'tr', 8)
  assert.equal(getVersion(db, exp.versionId)?.deployment, 'withdrawn')
  // 人工恢复（模拟 deployment 回到 active + restore 标记）
  db.prepare(`UPDATE experience_versions SET deployment = 'active' WHERE version_id = ?`).run(exp.versionId)
  markMemoryRestored(db, exp.id)
  attributeFailures(exp.id, 'tr2', 2)
  assert.equal(getVersion(db, exp.versionId)?.deployment, 'active', '恢复后 30 天内不得再次自动退役')
})
