/**
 * 真实线动作证据派生（P1-C 修复）：干预台账 → ActionEvidence。
 * 验证 real 作用域优化资格不再被硬编码 unknown 关断，且聚合取最保守。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-pm-evidence-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
const { deriveActionEvidenceFromLedger } = await import('../server/services/workshop/process-model/eligibility-service')

const now = new Date().toISOString()

function fixture(rows: Array<{ ack: string, runId?: string }>) {
  const db = openWorkshopDb(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  let i = 0
  for (const r of rows) {
    i += 1
    db.prepare(`INSERT INTO intervention_events (id, ts, line_id, node_id, node_name, from_value, to_value, ack, path, channel_id, verdict, recipe_run_id, created_at, updated_at)
      VALUES (?,?, 'ln-r','n-1','节点', 10, 11, ?, 'agent', 'ch-1', 'unassessed', ?, ?, ?)`)
      .run(`ie-${i}`, now, r.ack, r.runId ?? 'run-1', now, now)
  }
  return db
}

test('全部 readback-verified → observed（请求/生效/回读三证齐备）', () => {
  const db = fixture([{ ack: 'readback-verified' }, { ack: 'readback-verified', runId: 'run-2' }])
  try {
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-1', 'run-2']), 'observed')
  }
  finally { db.close() }
})

test('含 transport-ack（仅链路受理）→ ack_only（最保守聚合）', () => {
  const db = fixture([{ ack: 'readback-verified' }, { ack: 'transport-ack' }])
  try {
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-1']), 'ack_only')
  }
  finally { db.close() }
})

test('含 unverified（未证实）→ ack_only', () => {
  const db = fixture([{ ack: 'unverified' }])
  try {
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-1']), 'ack_only')
  }
  finally { db.close() }
})

test('批次内无写入记录 → unknown（fail-closed：无动作窗口不当优化样本）', () => {
  const db = fixture([{ ack: 'readback-verified', runId: 'run-other' }])
  try {
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-mine']), 'unknown')
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', []), 'unknown')
  }
  finally { db.close() }
})

test('runIds 过滤生效：证据只来自数据集覆盖的批次（谱系精确）', () => {
  const db = fixture([
    { ack: 'readback-verified', runId: 'run-a' },
    { ack: 'transport-ack', runId: 'run-b' },
  ])
  try {
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-a']), 'observed', '仅 run-a 在数据集内')
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-b']), 'ack_only')
  }
  finally { db.close() }
})
