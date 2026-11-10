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

function fixture(rows: Array<{ ack: string, runId?: string, nodeId?: string }>) {
  const db = openWorkshopDb(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  let i = 0
  for (const r of rows) {
    i += 1
    db.prepare(`INSERT INTO intervention_events (id, ts, line_id, node_id, node_name, from_value, to_value, ack, path, channel_id, verdict, recipe_run_id, created_at, updated_at)
      VALUES (?,?, 'ln-r',?, '节点', 10, 11, ?, 'agent', 'ch-1', 'unassessed', ?, ?, ?)`)
      .run(`ie-${i}`, now, r.nodeId ?? 'n-1', r.ack, r.runId ?? 'run-1', now, now)
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

test('MV 节点收窄：同批次其他参数的 transport-ack 不污染本模型证据', () => {
  // P1 复验修正(2026-11-11):证据按 spec 的 MV 节点收窄 ——
  // 实测:influent-flow 的 transport-ack 曾把 blower(本模型 MV)的
  // readback-verified 证据拉低成 ack_only,real 资格被误拒。
  const db = fixture([
    { ack: 'readback-verified', runId: 'run-1', nodeId: 'n-1' },
    { ack: 'transport-ack', runId: 'run-1', nodeId: 'n-other' },
  ])
  try {
    // 无 MV 声明 → 全节点口径(最保守:ack_only)
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-1']), 'ack_only')
    // 声明 MV 节点 n-1(readback-verified) → 其他节点的 transport-ack 不污染
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-1'], ['n-1']), 'observed')
  }
  finally { db.close() }
})

test('MV 执行节点映射：controlNodeId(DCW) 与 nodeId(DAQ 镜像) 都纳入过滤集', () => {
  // 台账记录的是写控执行节点(DCW dw-...),spec 的 MV 引用可能是 DAQ 镜像(dn-...)
  const db = fixture([
    { ack: 'readback-verified', runId: 'run-1', nodeId: 'dw-exec' },
    { ack: 'transport-ack', runId: 'run-1', nodeId: 'n-other' },
  ])
  try {
    assert.equal(deriveActionEvidenceFromLedger(db, 'ln-r', ['run-1'], ['dn-mirror', 'dw-exec']), 'observed')
  }
  finally { db.close() }
})
