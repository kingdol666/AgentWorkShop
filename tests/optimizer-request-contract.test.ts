import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProcessModelSpec } from '../server/services/workshop/process-model/contracts'
import type { OptimizationProfile } from '../server/services/workshop/optimization/contracts'
import { classifyRecommendation } from '../server/services/workshop/optimization/recommendation.service'
import { parseProcessModelSpec } from '../server/services/workshop/process-model/spec'
import { assertArxArtifactCurrent } from '../server/services/workshop/process-model/artifact-validation'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-optimizer-request-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { getProfileRepo } = await import('../server/services/workshop/optimization/profile.repo')
const { getProcessModelSpecRepo } = await import('../server/services/workshop/process-model/spec.repo')
const { createBinding } = await import('../server/services/workshop/optimization/binding.service')
const { getRunRepo } = await import('../server/services/workshop/optimization/run.repo')
const { getRunStatus, solve } = await import('../server/services/workshop/optimization/manager')
const { predictWithModel, verifyModelArtifact } = await import('../server/services/workshop/aml/predictor')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'request.sqlite'))
configureAmlRuntime(db)
after(() => db.close())
const now = new Date().toISOString()
db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-r','u1','request',?)`).run(now)
db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-r','request','',1,?,?)`).run(now, now)
db.prepare(`INSERT INTO workspace_channels (workspace_id, channel_id, created_at) VALUES ('ws-r','ch-r',?)`).run(now)
db.prepare(`INSERT INTO agents (id, name, harness, created_at, updated_at) VALUES ('tpl-r','request','mock',?,?)`).run(now, now)
db.prepare(`INSERT INTO channel_agents (id, channel_id, template_id, name, harness, token, created_at, updated_at) VALUES ('ca-r','ch-r','tpl-r','request','mock','tok-r',?,?)`).run(now, now)
db.prepare(`INSERT INTO aml_datasets (id, line_id, product_id, recipe_id, spec_json, sha256, path, created_at, lineage_verified) VALUES ('ds-r','ln-r','pd-r','rc-r','{}','x','p',?,1)`).run(now)
db.prepare(`INSERT INTO aml_jobs (id, dataset_id, purpose, status, created_at) VALUES ('job-r','ds-r','mpc_surrogate','evaluating',?)`).run(now)
db.prepare(`INSERT INTO aml_experiments (id, job_id, dataset_id, created_at) VALUES ('exp-r','job-r','ds-r',?)`).run(now)
db.prepare(`INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage, path, artifact_kind, created_at)
  VALUES ('mdl-r','exp-r','ds-r','pd-r','rc-r','mpc_surrogate','candidate',?,'static_response@1',?)`).run(join(process.env.AW_HOME!, 'missing-artifact'), now)

function specFixture(): ProcessModelSpec {
  return {
    schemaVersion: 2, id: 'pms-r', version: 1,
    lineId: 'ln-r', productId: 'pd-r', recipeId: 'rc-r', recipeVersion: 1,
    conditions: [{ id: 'c-r', match: [{ field: 'recipeId', op: 'eq', value: 'rc-r' }] }],
    variables: [
      { id: 'mv1', nodeId: 'n-mv', role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 0, min: 0, max: 100 },
      { id: 'cv1', nodeId: 'n-cv', role: 'cv', field: 'value', unit: 'bar', scale: 1, offset: 0 },
    ],
    timing: { beatMs: 1000, historySteps: 10, horizonSteps: 5, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 0.001, standardize: false } },
    datasetPolicy: { split: { valRatio: 0.2, testRatio: 0.2, seed: 1 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 0, max: 100 } } },
    purpose: 'mpc_surrogate',
  }
}

getProcessModelSpecRepo().insert(parseProcessModelSpec(specFixture()))

function bindProfile(id: string, template: OptimizationProfile['problemTemplateRef'], modelId = 'mdl-r') {
  const dynamic = template === 'linear_mpc_quadratic@1'
  getProfileRepo().insert({
    schemaVersion: 1, id, version: 1,
    modelRef: { modelId, artifactKind: dynamic ? 'linear_state_space@1' : 'static_response@1', artifactHash: '', modelInterface: dynamic ? 'linear_state_space' : 'static_response', stage: 'candidate' },
    problemTemplateRef: template, problemConfig: {},
    solverRef: dynamic ? 'osqp_mpc@1' : 'scipy_slsqp@1', solverVersion: '1',
    processSpecRef: 'pms-r@1', conditionIds: [], status: 'draft',
  })
  getProfileRepo().publish(id, 1)
  return createBinding({ workspaceId: 'ws-r', channelId: 'ch-r', agentInstanceId: 'ca-r', profileId: id, profileVersion: 1 })
}

const dynamicBinding = bindProfile('profile-dynamic', 'linear_mpc_quadratic@1')
const staticBinding = bindProfile('profile-static', 'steady_response@1')

test('Manager rejects horizon overrides and nonpositive/noninteger values before loading artifacts', async () => {
  // SW7.1:请求级 horizon 已整体移除(SolveOptions 无该字段)—— 传值会被 additionalProperties/TS 拒绝;
  // 语义锁定:请求级时域覆盖不可达,时域恒等于已发布问题(静态 1 / 动态 spec.horizonSteps)。
  const withHorizon = { bindingId: dynamicBinding.id, horizon: 6 } as unknown as Parameters<typeof solve>[1]
  await assert.rejects(solve('ca-r', withHorizon), { code: 'MODEL_ARTIFACT_MISSING' })
  await assert.rejects(solve('ca-r', { bindingId: staticBinding.id }), { code: 'MODEL_ARTIFACT_MISSING' })
  assert.equal(getRunRepo().listRuns().length, 0)
})

test('Manager accepts matching fixed horizons and omission, preserving the downstream artifact check', async () => {
  // A deliberately missing artifact stops before any Worker; identical downstream errors prove the guard accepted the request.
  for (const binding of [dynamicBinding, staticBinding]) {
    await assert.rejects(solve('ca-r', { bindingId: binding.id }), { code: 'MODEL_ARTIFACT_MISSING' })
  }
})

test('Recommendation classification rejects invalid coverage, distance and unassessed evidence', () => {
  const valid = { coverage: 0.95, calibrationFresh: true, inputDistance: 0.1 }
  for (const coverage of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 1.01]) {
    assert.equal(classifyRecommendation({ evidenceSource: 'real', uqEvidence: { ...valid, coverage }, candidateFeasible: true }).status, 'unverified')
  }
  for (const inputDistance of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(classifyRecommendation({ evidenceSource: 'real', uqEvidence: { ...valid, inputDistance }, candidateFeasible: true }).status, 'unverified')
  }
  assert.equal(classifyRecommendation({ evidenceSource: 'unassessed', uqEvidence: valid, candidateFeasible: true }).status, 'unverified')
  for (const evidenceSource of ['real', 'simulation'] as const) {
    assert.equal(classifyRecommendation({ evidenceSource, uqEvidence: { ...valid, coverage: 1, inputDistance: 0 }, candidateFeasible: true }).status, 'verified')
  }
})

function insertRecommendation(runId: string, validUntil: string) {
  db.prepare(`INSERT INTO optimizer_runs (id, binding_id, profile_id, profile_version, problem_ir_hash, status, started_at)
    VALUES (?, ?, 'profile-dynamic', 1, 'h', 'optimal', ?)`).run(runId, dynamicBinding.id, now)
  const [candidateId] = getRunRepo().insertCandidates(runId, [{ seq: 0, controls: [[1]], predicted: [[1]], cost: 0, constraints: [], feasible: true }])
  return getRunRepo().insertRecommendation({
    id: `rec-${runId}`, runId, candidateId: candidateId!, problemIrHash: 'h', modelArtifactHash: 'h', evidenceSource: 'simulation', uqEvidence: null,
    status: 'unverified', validUntil,
  })
}

test('Run status expires TTL recommendations after ownership checks and persists the audit status', () => {
  const expired = insertRecommendation('run-expired', new Date(Date.now() - 60_000).toISOString())
  assert.throws(() => getRunStatus('other-agent', expired.runId), { status: 403, code: 'BINDING_NOT_OWNED' })
  assert.equal(getRunRepo().getRecommendation(expired.id)?.status, 'unverified')
  assert.equal(getRunStatus('ca-r', expired.runId).recommendation?.status, 'expired')
  assert.equal(getRunRepo().getRecommendation(expired.id)?.status, 'expired')
  const fresh = insertRecommendation('run-fresh', new Date(Date.now() + 60_000).toISOString())
  assert.equal(getRunStatus('ca-r', fresh.runId).recommendation?.status, 'unverified')
})

test('Built-in trainers reject unsupported MD and feature inputs instead of silently discarding them', () => {
  for (const role of ['md', 'feature'] as const) {
    for (const staticModel of [false, true]) {
      const spec = specFixture()
      if (staticModel) {
        spec.trainer = { ref: 'static_response@1', config: { order: 1, ridgeLambda: 0.001, standardize: false } }
        spec.modelInterface = { id: 'static_response', version: 1, inputSemantics: 'setpoint', mode: 'static' }
        spec.timing.horizonSteps = 1
      }
      assert.doesNotThrow(() => parseProcessModelSpec(spec))
      spec.variables.push({ id: 'unsupported', nodeId: 'n-extra', role, field: 'value', unit: 'bar', scale: 1, offset: 0 })
      assert.throws(() => parseProcessModelSpec(spec), { status: 422, code: 'UNSUPPORTED_MODEL_INPUT' })
    }
  }
})

function legacyArxArtifact() {
  return {
    kind: 'linear_state_space@1', stateDim: 1, arOrder: 1, inputOrder: 1,
    mvOrder: ['mv1'], cvOrder: ['cv1'], delaysSteps: { mv1: 0 }, K: 0,
    A: [[0.5]], B: [[0]], C: [[1]], D: [[2]], bias: [0],
    layout: { yOffset: 0, uOffset: 1, stateDim: 1, K: 0 },
  }
}

test('Artifact guard rejects only zero-delay ARX feedthrough and permits general state-space D', () => {
  const old = legacyArxArtifact()
  assert.throws(() => assertArxArtifactCurrent(old, 'legacy-id'), { status: 409, code: 'MODEL_RETRAIN_REQUIRED', message: /legacy-id.*重新训练/ })
  assert.doesNotThrow(() => assertArxArtifactCurrent({ ...old, B: [[2]], D: [[0]] }, 'new-arx'))
  assert.doesNotThrow(() => assertArxArtifactCurrent({ ...old, delaysSteps: { mv1: 1 } }, 'delayed-arx'))
  const generic = { kind: old.kind, mvOrder: old.mvOrder, delaysSteps: old.delaysSteps, D: old.D }
  assert.doesNotThrow(() => assertArxArtifactCurrent(generic, 'generic-ss'))
  for (const omittedMarker of ['arOrder', 'inputOrder', 'layout']) {
    const partial = Object.fromEntries(Object.entries(old).filter(([key]) => key !== omittedMarker))
    assert.doesNotThrow(() => assertArxArtifactCurrent(partial, 'non-arx'))
  }
  const mixed = { ...old, mvOrder: ['delayed', 'immediate'], delaysSteps: { delayed: 1, immediate: 0 }, D: [[2, 0], [0, 3]] }
  assert.throws(() => assertArxArtifactCurrent(mixed, 'mixed-arx'), { code: 'MODEL_RETRAIN_REQUIRED' })
})

test('Optimizer and AML predictor reject existing legacy ARX artifacts without modifying frozen files', async () => {
  const modelId = 'mdl-legacy-arx'
  const modelDir = join(process.env.AW_HOME!, 'legacy-arx')
  mkdirSync(modelDir)
  const artifactPath = join(modelDir, 'model.json')
  const original = JSON.stringify(legacyArxArtifact())
  writeFileSync(artifactPath, original)
  const io = {
    version: 2, historySteps: 1, horizonSteps: 5, allNodes: ['mv1', 'cv1'],
    controlNodes: ['mv1'], targetNodes: ['cv1'], mvOrder: ['mv1'], cvOrder: ['cv1'], beatMs: 1000,
  }
  db.prepare(`INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage, path, artifact_kind, io_spec_json, created_at)
    VALUES (?, 'exp-r', 'ds-r', 'pd-r', 'rc-r', 'mpc_surrogate', 'candidate', ?, 'linear_state_space@1', ?, ?)`).run(modelId, modelDir, JSON.stringify(io), now)
  const binding = bindProfile('profile-legacy', 'linear_mpc_quadratic@1', modelId)
  await assert.rejects(solve('ca-r', { bindingId: binding.id }), { status: 409, code: 'MODEL_RETRAIN_REQUIRED', message: /mdl-legacy-arx.*重新训练/ })
  await assert.rejects(predictWithModel(modelId, { history: [[0, 0]], controls: [[1]], steps: 1 }), { status: 409, code: 'MODEL_RETRAIN_REQUIRED', message: /mdl-legacy-arx.*重新训练/ })
  const verification = await verifyModelArtifact(modelId)
  assert.equal(verification.ok, false)
  assert.match(verification.detail, /mdl-legacy-arx.*重新训练/)
  assert.equal(readFileSync(artifactPath, 'utf8'), original)
  assert.equal(getRunRepo().listRuns({ bindingId: binding.id }).length, 0)
})
