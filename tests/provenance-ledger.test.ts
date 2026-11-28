/**
 * 批次 N：操作与数采全量追溯（M46/M48/M50）。
 *  - 已受理写：attempt（含想写值） + intervention 上下文 + 统一检索；
 *  - 拒绝尝试：保留 payload，不出现在 accepted 列表；
 *  - 无 DAQ 数据：快照如实标 missing/no_samples，不插值；
 *  - 覆盖率：exact/run/time-window/unknown 分开计数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-provenance-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const ledger = await import('../server/services/workshop/aml/intervention-ledger')
const { recordWriteIntent, linkWriteAttemptIntervention, settleWriteAttempt } = await import('../server/services/workshop/dcw/write-attempt-ledger')
const { queryOperationProvenance } = await import('../server/services/workshop/aml/provenance-query')
const { captureOperationEvidence } = await import('../server/services/workshop/daq/provenance-evidence')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'provenance.sqlite'))
configureAmlRuntime(db)

test('accepted write carries attempt payload, context and unified query', () => {
  const attemptId = recordWriteIntent(db, {
    nodeId: 'dcw-hold',
    lineId: 'L1',
    productId: 'P1',
    recipeId: 'R1',
    recipeRevision: '3',
    runId: 'run-1',
    channelId: 'ch-1',
    agentId: 'ag-1',
    sessionId: 's-1',
    payloadHash: 'hash-1',
    payload: { eng: 62.5, unit: 'MPa', min: 0, max: 100 },
  })
  const interventionId = ledger.recordIntervention({
    nodeId: 'dcw-hold',
    nodeName: '保压压力SP',
    lineId: 'L1',
    fromValue: 60,
    toValue: 62.5,
    actualValue: 62.4,
    ack: 'readback-verified',
    path: 'agent',
    actor: 'ag-1',
    channelId: 'ch-1',
    approvalId: 'ap-1',
    recipeRunId: 'run-1',
    targetNodeId: 'daq-thickness',
    criterion: { metric: 'wall_thickness', op: '>', threshold: 3.1, mde: 0.1 },
    settleMs: 45_000,
    attemptId,
    taskId: 'task-1',
    sessionId: 's-1',
    productId: 'P1',
    recipeId: 'R1',
    recipeRevision: '3',
    contextSource: 'exact',
  })
  assert.ok(interventionId)
  linkWriteAttemptIntervention(db, attemptId, interventionId!)

  const page = queryOperationProvenance(db, { productId: 'P1', recipeId: 'R1', recipeRevision: '3', nodeId: 'dcw-hold' })
  assert.equal(page.items.length, 1)
  const item = page.items[0]!
  assert.equal(item.attemptId, attemptId)
  assert.equal(item.contextSource, 'exact')
  assert.equal(item.fromValue, 60)
  assert.equal(item.toValue, 62.5)
  assert.equal(item.sessionId, 's-1')
  assert.equal(item.taskId, 'task-1')
  assert.equal(item.daq, null)
  assert.equal(page.coverage.exact, 1)
  assert.equal(page.coverage.missingRaw, 1)
  assert.equal(page.attempts.filter(a => a.id === attemptId).length, 0, 'accepted 尝试不重复出现在未受理列表')
})

test('rejected attempt keeps intended value and stays out of accepted list', () => {
  const rejected = recordWriteIntent(db, {
    nodeId: 'dcw-temp',
    lineId: 'L1',
    productId: 'P1',
    recipeId: 'R1',
    recipeRevision: '3',
    runId: 'run-1',
    payloadHash: 'hash-2',
    payload: { eng: 185.5, unit: 'C' },
  })
  settleWriteAttempt(db, rejected, 'rejected', '联锁拒绝：超过上限')

  const page = queryOperationProvenance(db, { productId: 'P1', nodeId: 'dcw-temp' })
  assert.equal(page.items.length, 0, '拒绝尝试不是 accepted 干预')
  const attempt = page.attempts.find(a => a.id === rejected)
  assert.ok(attempt, '拒绝尝试必须可见')
  assert.equal(attempt!.state, 'rejected')
  assert.equal(attempt!.payload.eng, 185.5, '必须保留想写值')
  assert.equal(attempt!.productId, 'P1')
  assert.equal(attempt!.runId, 'run-1')
})

test('missing DAQ is recorded honestly (no interpolation)', async () => {
  const interventionId = ledger.recordIntervention({
    nodeId: 'dcw-hold',
    nodeName: '保压压力SP',
    lineId: 'L1',
    fromValue: 60,
    toValue: 61,
    actualValue: null,
    ack: 'transport-ack',
    path: 'manual',
    actor: 'u-1',
    targetNodeId: 'daq-no-samples',
    settleMs: 45_000,
    productId: 'P1',
    recipeId: 'R1',
    recipeRevision: '3',
    contextSource: 'exact',
  })
  assert.ok(interventionId)
  const result = await captureOperationEvidence(db, interventionId!)
  assert.equal(result.ok, true)
  assert.equal(result.sampleCount, 0)
  assert.equal(result.joinQuality, 'none')
  assert.ok(result.missingReason === 'no_samples' || result.missingReason === 'raw_expired')
  const row = db.prepare('SELECT sample_count AS n, series_json AS series, missing_reason AS reason FROM operation_daq_evidence WHERE intervention_id = ?').get(interventionId!) as { n: number, series: string, reason: string }
  assert.equal(row.n, 0)
  assert.deepEqual(JSON.parse(row.series), [], '不得插值/编造序列')
  assert.ok(row.reason)
})
