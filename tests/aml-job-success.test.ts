/**
 * G2 作业成功语义(A12/C11/C12):
 *  - 状态机:done 只能从 evaluating 进入,终态不可迁出;
 *  - 工件缺失 → 注册失败,不产生 done/半成品;
 *  - 幂等:重复注册返回同一 modelId。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-aml-success-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { AML_JOB_TRANSITIONS, canTransitionJob } = await import('../server/services/workshop/aml/aml.repo')
const { registerModelFromJob } = await import('../server/services/workshop/aml/model-registry')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'aml-success.sqlite'))
configureAmlRuntime(db)
const rt = getAmlRuntime()
const now = new Date().toISOString()

rt.repo.dataset.insert({ id: 'ds-s', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', runIds: ['r1'], specJson: '{}', sha256: 'x', rowCount: 100, fromMs: 0, toMs: 1, path: join(rt.datasetsDir, 'ds-s'), createdBy: 't', createdByKind: 'user', note: '', createdAt: now })
rt.repo.job.insert({ id: 'job-s', datasetId: 'ds-s', purpose: 'mpc_surrogate', budget: {}, createdAt: now })

test('C12:状态机守卫——queued 不能直接 done;evaluating 才能 done;终态不可迁出', () => {
  assert.equal(canTransitionJob('queued', 'done'), false)
  assert.equal(canTransitionJob('evaluating', 'done'), true)
  assert.equal(canTransitionJob('done', 'training'), false)
  assert.deepEqual(AML_JOB_TRANSITIONS.done, [])
  assert.equal(rt.repo.job.setState('job-s', 'done', 'done', 100), false, 'queued→done 必须被拒绝')
  assert.equal(rt.repo.job.get('job-s')!.status, 'queued')
  assert.equal(rt.repo.job.setState('job-s', 'training', 'train', 10), true)
  assert.equal(rt.repo.job.setState('job-s', 'evaluating', 'evaluate', 80), true)
  assert.equal(rt.repo.job.finish('job-s', 'done', '{}', '{}', '', now, 'mdl-s'), true)
  const row = rt.repo.job.get('job-s')!
  assert.equal(row.status, 'done')
  assert.equal(row.modelId, 'mdl-s')
  assert.equal(rt.repo.job.setState('job-s', 'training', 'train', 10), false, '终态不可迁出')
})

test('C11:工件缺失 → 注册失败且不产生模型(无假成功)', () => {
  const jobId = 'job-bad'
  rt.repo.job.insert({ id: jobId, datasetId: 'ds-s', purpose: 'mpc_surrogate', budget: {}, createdAt: now })
  rt.repo.job.setState(jobId, 'training', 'train', 10)
  rt.repo.job.setState(jobId, 'evaluating', 'evaluate', 80)
  const artifacts = join(rt.jobsDir, jobId, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'metrics.json'), '{"platform":{"oneStepTest":{"windows":10,"nrmse":0.01}}}')
  assert.throws(() => registerModelFromJob(jobId, { passed: true, checks: [] }, '{"platform":{"oneStepTest":{"windows":10,"nrmse":0.01}}}'))
  assert.equal(rt.repo.model.get(`mdl-${jobId.slice(4)}`), undefined)
  // 作业行仍是 evaluating,没有被误标 done
  assert.equal(rt.repo.job.get(jobId)!.status, 'evaluating')
})

test('C11:工件齐备 → 注册成功;重复注册返回同一 modelId(幂等)', () => {
  const jobId = 'job-ok'
  rt.repo.job.insert({ id: jobId, datasetId: 'ds-s', purpose: 'mpc_surrogate', budget: {}, createdAt: now })
  rt.repo.job.setState(jobId, 'training', 'train', 10)
  rt.repo.job.setState(jobId, 'evaluating', 'evaluate', 80)
  const artifacts = join(rt.jobsDir, jobId, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  const artifact = { kind: 'linear_state_space@1', schemaVersion: 1, stateDim: 1, arOrder: 1, inputOrder: 1, mvOrder: ['mv1'], cvOrder: ['cv1'], delaysSteps: { mv1: 0 }, K: 1, A: [[0.7]], B: [[1]], C: [[1]], D: [[0]], bias: [0], layout: { yOffset: 0, uOffset: 1, stateDim: 1, K: 1 } }
  writeFileSync(join(artifacts, 'model.json'), JSON.stringify(artifact))
  writeFileSync(join(artifacts, 'metrics.json'), JSON.stringify({ platform: { oneStepTest: { windows: 10, nrmse: 0.01 }, rolloutTest: { windows: 10, horizon: 4, nrmse: 0.05 }, rolloutImprovement: 0.5 } }))
  // 数据集 manifest 供 io_spec 读取
  mkdirSync(rt.datasetsDir, { recursive: true })
  mkdirSync(join(rt.datasetsDir, 'ds-s'), { recursive: true })
  writeFileSync(join(rt.datasetsDir, 'ds-s', 'manifest.json'), JSON.stringify({
    version: 2, allNodes: ['n-mv', 'n-cv'], controlNodes: ['n-mv'], targetNodes: ['n-cv'], featureNodes: [],
    shapes: { x: [10, 4, 2], u: [10, 2, 1], y: [10, 2, 1] },
    split: { train: 6, val: 2, test: 2, trainRunIds: [], valRunIds: [], testRunIds: [] },
    norm: { x: { mean: [0, 0], std: [1, 1] }, u: { mean: [0], std: [1] }, y: { mean: [0], std: [1] } },
    beatMs: 1000,
    variables: [{ id: 'mv1', nodeId: 'n-mv', role: 'mv', unit: 'bar', scale: 1, offset: 0, delayMs: 0 }, { id: 'cv1', nodeId: 'n-cv', role: 'cv', unit: 'μm', scale: 1, offset: 0 }],
  }))
  const metrics = JSON.stringify({ platform: { oneStepTest: { windows: 10, nrmse: 0.01 }, rolloutTest: { windows: 10, horizon: 4, nrmse: 0.05 }, rolloutImprovement: 0.5 }, artifactKind: 'linear_state_space@1' })
  const first = registerModelFromJob(jobId, { passed: true, checks: [] }, metrics).modelId
  assert.ok(first)
  const model = rt.repo.model.get(first!)!
  assert.equal(model.artifactKind, 'linear_state_space@1')
  assert.equal(model.modelInterface, 'linear_state_space')
  assert.ok(model.artifactHash.length === 64)
  const second = registerModelFromJob(jobId, { passed: true, checks: [] }, metrics).modelId
  assert.equal(second, first, '重复注册必须返回同一 modelId')
})
