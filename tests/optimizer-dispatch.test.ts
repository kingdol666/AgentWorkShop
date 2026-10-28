/** SW5/D13/D14 治理下发单测:门序/防伪/幂等锚/单一咽喉/在飞三前缀/撤权收敛。 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const testHome = mkdtempSync(join(tmpdir(), 'aw-optimizer-dispatch-'))
process.env.AW_HOME = testHome
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('@/server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('@/server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('@/server/services/workshop/ops/ops')
const { createAuditRepo } = await import('@/server/services/workshop/db/ops.repo')
const { getProfileRepo, parseProfileRow } = await import('@/server/services/workshop/optimization/profile.repo')
const { getProcessModelSpecRepo } = await import('@/server/services/workshop/process-model/spec.repo')
const { parseProcessModelSpec } = await import('@/server/services/workshop/process-model/spec')
const { getBindingRepo } = await import('@/server/services/workshop/optimization/binding.repo')
const { getRunRepo } = await import('@/server/services/workshop/optimization/run.repo')
const { getToolApprovals } = await import('@/server/services/workshop/agents/tool-approvals')
const { getDcwController } = await import('@/server/services/workshop/dcw/dcw-controller')
const { createCrosscheckRepo } = await import('@/server/services/workshop/optimization/crosscheck.service')
const {
  createDispatchCard, decideOptimizerDispatch, recipeWriteInFlight, cancelPendingDispatchForUser, isOptimizerDispatchCard,
} = await import('@/server/services/workshop/optimization/dispatch.service')
const { buildProblemIR } = await import('@/server/services/workshop/optimization/problem-builder')
const { computeProblemIrHash } = await import('@/server/services/workshop/optimization/contracts')
const { DcwNode } = await import('@/server/services/workshop/dcw/dcw-node')
const { getDcwLineRepo } = await import('@/server/services/workshop/dcw/dcw-line.repo')

const db = openWorkshopDb(join(testHome, 'dispatch.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({ audit: createAuditRepo(db) })
// 产线面 mock(仓库 create 生成自增 id,spec 固定 ln-d → 直接打桩 byId)
;(getDcwLineRepo() as unknown as { byId: unknown }).byId = (id: string) =>
  id === 'ln-d' ? { id: 'ln-d', name: '产线D', simulated: true, controlMode: 'manual' } : undefined

const admin = { id: 'u-admin', name: 'Admin', role: 'admin' } as never

const spec = {
  schemaVersion: 2, id: 'pms-d', version: 1,
  lineId: 'ln-d', productId: 'pd-d', recipeId: 'rc-d', recipeVersion: 1,
  conditions: [{ id: 'c-d', match: [{ field: 'recipeId', op: 'eq', value: 'rc-d' }] }],
  variables: [
    { id: 'mv1', nodeId: 'n-mv', role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: 0, min: 0, max: 100, maxStep: 20, controlNodeId: 'dw-1' },
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

const artifactHash = 'c'.repeat(64)
// 工件目录用本地临时目录(与 AW_HOME 解耦;aml_models.path 只需存在可读)
const modelDir = mkdtempSync(join(tmpdir(), 'aw-mdl-dispatch-'))
const artifact = {
  kind: 'linear_state_space@1', schemaVersion: 1,
  stateDim: 1, arOrder: 1, inputOrder: 1,
  mvOrder: ['mv1'], cvOrder: ['cv1'], delaysSteps: { mv1: 0 }, K: 1,
  A: [[0.3]], B: [[0]], C: [[1]], D: [[0.7]], bias: [8],
  layout: { yOffset: 0, uOffset: 1, stateDim: 1, K: 1 },
  norm: { x: { mean: [50], std: [10] }, u: { mean: [50], std: [10] }, y: { mean: [50], std: [10] } },
  uq: { method: 'split_conformal', qhatPerCv: [5], coverageTest: 0.95, alpha: 0.1, horizon: 1, nValBlocks: 10, nValRuns: 10, nValUniqueSteps: 480, nTestBlocks: 4, nTestRuns: 4, nUniqueTestSteps: 480, calibratedAt: new Date().toISOString() },
  metrics: { oneStepVal: { windows: 1, nrmse: 0 }, oneStepNrmse: 0, rolloutNrmse: 0, persistenceNrmse: 0, rolloutImprovement: 0, windows: 1 },
  residual: { mean: 0, std: 1 },
}

const now = new Date().toISOString()
// channel_agents 行(agent 实例身份;createBinding/assertAgentAccess 需要);channels/workspaces 父行先行
db.prepare(`INSERT INTO channels (id, name, description, enabled, owner_user_id, created_at, updated_at)
  VALUES ('ch-d','dispatch','',1,'u-admin',?,?)`).run(now, now)
db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-d','u-admin','w',?)`).run(now)
db.prepare(`INSERT INTO channel_agents (id, channel_id, name, harness, token, created_at, updated_at)
  VALUES ('ca-d','ch-d','ca-d','mock','tok-d',?,?)`).run(now, now)
getProcessModelSpecRepo().insert(parseProcessModelSpec(spec))
// FK 链:dataset→(省略 lineage 门:manager 不经此路径,dispatch 直接读模型行)→job→experiment→model
db.prepare(`INSERT INTO aml_datasets (id, line_id, product_id, recipe_id, spec_json, sha256, path, created_at, lineage_verified)
  VALUES ('ds-d','ln-d','pd-d','rc-d','{}','x',?, ?,1)`).run(modelDir, now)
db.prepare(`INSERT INTO aml_jobs (id, dataset_id, purpose, status, created_at) VALUES ('job-d','ds-d','mpc_surrogate','done',?)`).run(now)
db.prepare(`INSERT INTO aml_experiments (id, job_id, dataset_id, created_at) VALUES ('e','job-d','ds-d',?)`).run(now)
db.prepare(`INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage, io_spec_json, metrics_json, path,
    created_by, note, label, description, line_id, objective_id, artifact_kind, schema_version, model_interface, artifact_hash, legacy, created_at)
  VALUES ('mdl-d','e','ds-d','pd-d','rc-d','mpc_surrogate','production','{}','{}',?,'t','','l','d','ln-d','','linear_state_space@1',1,'linear_state_space',?,'',?)`)
  .run(modelDir, artifactHash, now)

const profileRow = getProfileRepo().insert({
  schemaVersion: 1, id: 'profile-d', version: 1,
  modelRef: { modelId: 'mdl-d', artifactKind: 'linear_state_space@1', artifactHash, modelInterface: 'linear_state_space', stage: 'production' },
  problemTemplateRef: 'linear_mpc_quadratic@1',
  problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 50 } } },
  solverRef: 'osqp_mpc@1', solverVersion: '1', processSpecRef: 'pms-d@1', conditionIds: [], status: 'published',
} as never, admin.id)

const binding = getBindingRepo().insert({
  id: 'binding-d', workspaceId: 'ws-d', channelId: 'ch-d', channelAgentId: 'ca-d',
  profileId: 'profile-d', profileVersion: 1, capabilities: [], mode: 'recommendation',
})

const dwNode = new DcwNode({ id: 'dw-1', templateRef: 'dcw-temp-sp', driver: 'mock', min: 0, max: 100, unit: 'bar', decimals: 1 })
dwNode.value = 50
;(dwNode as unknown as { lineId: string }).lineId = 'ln-d'
const controller = getDcwController()
const recipeView = {
  id: 'rc-d', name: '配方D', lineId: 'ln-d', version: 1, productId: 'pd-d',
  params: [{ nodeId: 'dw-1', min: 0, max: 100, unit: 'bar' }],
}
const context = {
  lineId: 'ln-d', productId: 'pd-d', recipeId: 'rc-d', recipeVersion: 1, conditionId: 'c-d',
  capturedAt: now, eventAsOf: Date.now(), availabilityWatermark: null, dtMs: 1000,
  variables: spec.variables,
  history: Array.from({ length: 10 }, () => [50, 50]),
  timestamps: Array.from({ length: 10 }, (_, i) => Date.now() - (10 - i) * 1000),
  qualityMask: Array.from({ length: 10 }, () => [true, true]),
  currentInputs: { mv1: 50 }, currentOutputs: { cv1: 50 },
  evidenceSource: 'simulation' as const,
}
const irHash = (() => {
  // 冻结 hash 必须按「发布/运行时同一份往返数据」计算(parseProfileRow/parseProcessModelSpec/snapshot JSON),
  // 与 dispatch 的 assertNoDrift 完全同源(canonicalJson 不排序键,手写对象键序会漂移)
  const profileRoundTrip = parseProfileRow(getProfileRepo().get('profile-d', 1)!)
  const specRow = getProcessModelSpecRepo().get('pms-d', 1)!
  const specRoundTrip = parseProcessModelSpec(JSON.parse(specRow.specJson))
  const snapshot = JSON.parse(JSON.stringify(context))
  const modelRoundTrip = JSON.parse(JSON.stringify(artifact))
  return computeProblemIrHash(buildProblemIR({
    profile: profileRoundTrip as never,
    spec: specRoundTrip,
    artifact: modelRoundTrip as never,
    context: snapshot as never,
    runId: 'run-d',
  }))
})()

mkdirSync(modelDir, { recursive: true })
writeFileSync(join(modelDir, 'model.json'), JSON.stringify(artifact))

let seq = 0
function seedRunRec(opts: { status?: string, crosscheck?: boolean } = {}): string {
  seq++
  const runId = `run-d${seq}`
  const recId = `rec-d${seq}`
  const candidateId = `c-d${seq}`
  getRunRepo().insertRun({ id: runId, bindingId: binding.id, bindingRevision: binding.revision, profileId: profileRow.id, profileVersion: 1, ir: { hash: irHash } as never, context, startedAt: now })
  getRunRepo().insertCandidates(runId, [{ seq: 0, controls: [[55]], predicted: [[50], [51]], cost: 0, constraints: [], feasible: true }], 'mdl-d')
  db.prepare(`INSERT INTO optimizer_candidates (id, run_id, seq, model_id, controls_json, predicted_json) VALUES (?, ?, 0, 'mdl-d', '[[55]]', '[[50],[51]]')`).run(candidateId, runId)
  getRunRepo().insertRecommendation({
    id: recId, runId, candidateId, problemIrHash: irHash, modelArtifactHash: artifactHash,
    evidenceSource: 'simulation', uqEvidence: { method: 'split_conformal', coverageTest: 0.95, calibrationFresh: true, inputDistance: 0.2, artifactHash },
    status: opts.status ?? 'verified', validUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  })
  if (opts.crosscheck !== false) {
    createCrosscheckRepo(db).append({
      recommendationId: recId, runId, modelId: 'mdl-d', modelArtifactHash: artifactHash,
      contextHash: 'x', inputDistance: {}, predicted: [[50]], replayed: [[50]], devPerCv: [0],
      tol: 1e-6, qhatPerCv: [5], verdict: 'pass', conditionChanged: false, reason: 'test',
    })
  }
  return recId
}

// mock DCW 面(listRecipes/byId/applyRecipe;真实 DcwNode 保证 preflight/步限语义)
controller.listRecipes = () => [recipeView as never]
controller.byId = (id: string) => id === 'dw-1' ? dwNode : undefined
const applyRecipeCalls: Array<{ overrides: Array<{ nodeId: string, value: number }> }> = []
;(controller as unknown as { applyRecipe: unknown }).applyRecipe = async (_id: string, input: { overrides: Array<{ nodeId: string, value: number }> }) => {
  applyRecipeCalls.push(input)
  return { id: `dcw-run-${applyRecipeCalls.length}`, results: [{ ok: true, nodeId: input.overrides[0]?.nodeId, value: input.overrides[0]?.value, verify: { verdict: 'verified' } }], ackSummary: { verified: 1, unverified: 0, failed: 0, total: 1 } }
}

// 2026-10-28 运行门:下发批准要求产线有活动批次。测试夹具默认开一条与 recipeView 匹配的窗口;
// 「停线拒绝」由文件末尾的独立用例覆盖(它临时清空窗口)。
const { setActiveLineRun, clearActiveLineRun } = await import('@/server/services/workshop/dcw/line-run')
const activeRunFixture = {
  lineId: 'ln-d',
  runId: 'rr-dispatch-test',
  recipeId: 'rc-d',
  recipeVersion: 1,
  recipeName: '配方D',
  productId: 'pd-d',
  productName: '产品D',
  startedAt: new Date().toISOString(),
  taggedSamples: 0,
}
function startLineWindow(): void {
  setActiveLineRun({ ...activeRunFixture, startedAt: new Date().toISOString() })
}
startLineWindow()

function auditCount(action: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n
}

// assertAgentAccess 需要的 manager 存根(admin 短路 + owner 判定)
const managerGlobal = globalThis as { __workshopManager?: unknown }
managerGlobal.__workshopManager = {
  deps: { repos: { channelAgents: { findById: (id: string) => db.prepare('SELECT channel_id AS channelId FROM channel_agents WHERE id = ?').get(id) } } },
  channelPermissionsOf(channelId: string, user: { id: string, role?: string }) {
    const channel = db.prepare('SELECT owner_user_id AS owner FROM channels WHERE id = ?').get(channelId) as { owner: string }
    const isOwner = channel.owner === user.id
    return { isMember: isOwner || user.role === 'admin', canManage: isOwner || user.role === 'admin' }
  },
}

function dispatchState(recId: string): string {
  return String((db.prepare('SELECT dispatch_state AS s FROM optimizer_recommendations WHERE id = ?').get(recId) as { s?: string } | undefined)?.s ?? '')
}

/** 清理在飞 optimizer-recipe 卡(用例间隔离;卡默认 30min 超时会跨用例泄漏) */
function cleanupDispatchCards(): void {
  for (const a of getToolApprovals().listPending()) {
    if (a.nodeId.startsWith('optimizer-recipe:')) {
      try {
        getToolApprovals().decide(a.id, false, 'cleanup')
      }
      catch { /* 已收敛 */ }
    }
  }
}

test('在飞去重:三前缀等值匹配 + excludeApprovalId 排除自身', () => {
  const approvals = getToolApprovals()
  void approvals.request('ca-d', 'recipe:rc-d', 'dcw', 'x', { timeoutMs: 50 }).catch(() => {})
  void approvals.request('ca-d', 'recipe-propose:rc-d', 'dcw', 'x', { timeoutMs: 50 }).catch(() => {})
  void approvals.request('ca-d', 'optimizer-recipe:rc-d', 'dcw', 'x', { timeoutMs: 50 }).catch(() => {})
  const ids = recipeWriteInFlight('rc-d')
  assert.equal(ids.length, 3, '三前缀都在飞')
  const self = ids.find(i => i.startsWith('optimizer-recipe'))!
  assert.deepEqual(recipeWriteInFlight('rc-d', { excludeApprovalId: self }), ids.filter(i => i !== self))
  assert.equal(recipeWriteInFlight('rc-other').length, 0)
  // 清理在飞卡(避免泄漏到后续用例的配方级去重)
  for (const id of ids) {
    try {
      getToolApprovals().decide(id, false, 'cleanup')
    }
    catch { /* 已被 50ms 超时收敛 */ }
  }
  assert.equal(recipeWriteInFlight('rc-d').length, 0)
})

test('建卡门序:unverified → 403 DISPATCH_GATE_UNVERIFIED;verified 未互校 → 403 DISPATCH_GATE_NOT_CROSSCHECKED', async () => {
  const unverified = seedRunRec({ status: 'unverified' })
  await assert.rejects(createDispatchCard(admin as never, unverified, ''), { status: 403, code: 'DISPATCH_GATE_UNVERIFIED' })
  const noCross = seedRunRec({ crosscheck: false })
  await assert.rejects(createDispatchCard(admin as never, noCross, ''), { status: 403, code: 'DISPATCH_GATE_NOT_CROSSCHECKED' })
})

test('建卡成功:幂等锚 idle→dispatched;二次建卡 409;卡 payload 服务端构造(模型/工程双值+basis+exp_ref)', async () => {
  const recId = seedRunRec({})
  const card = await createDispatchCard(admin as never, recId, '测试下发')
  assert.equal(card.cardId, 'optimizer-recipe:rc-d')
  assert.ok(isOptimizerDispatchCard(card.cardId))
  assert.equal(dispatchState(recId), 'dispatched')
  assert.equal((db.prepare('SELECT initiator_user_id AS u FROM optimizer_recommendations WHERE id = ?').get(recId) as { u: string }).u, admin.id)
  const payload = card.payload as unknown as { recommendationId: string, modelFirstMove: Record<string, number>, packages: Array<{ params: Array<{ to: number, basis: string, exp_ref: string }> }> }
  assert.equal(payload.recommendationId, recId)
  assert.equal(payload.modelFirstMove.mv1, 55, '模型单位首步=55')
  assert.equal(payload.packages[0]!.params[0]!.to, 55, '工程值(scale=1)')
  assert.equal(payload.packages[0]!.params[0]!.basis, `optimizer-recommendation:${recId}`)
  assert.equal(payload.packages[0]!.params[0]!.exp_ref, String((db.prepare('SELECT run_id AS r FROM optimizer_recommendations WHERE id = ?').get(recId) as { r: string }).r))
  // 二次建卡:同配方在飞卡存在 → 先命中配方级去重;无卡时(建卡与挂卡之间崩溃)才命中幂等锚。
  // 两者都是 409 fail-closed,锚语义由「未建卡(idle)不可转移」用例单独锁定。
  await assert.rejects(createDispatchCard(admin as never, recId, ''), (err: { status?: number, code?: string }) =>
    err.status === 409 && (err.code === 'DISPATCH_ALREADY_DISPATCHED' || err.code === 'DISPATCH_RECIPE_IN_FLIGHT'))
  const rec2 = seedRunRec({})
  await assert.rejects(createDispatchCard(admin as never, rec2, ''), { status: 409, code: 'DISPATCH_RECIPE_IN_FLIGHT' })
  cleanupDispatchCards()
  // 清理后重试同 rec:锚已占 → DISPATCH_ALREADY_DISPATCHED(幂等锚独立生效)
  await assert.rejects(createDispatchCard(admin as never, recId, ''), { status: 409, code: 'DISPATCH_ALREADY_DISPATCHED' })
})

test('单一咽喉:批准 → D13 通过 → committed 抢占 → applyRecipe → executed + execute 审计', async () => {
  cleanupDispatchCards()
  const recId = seedRunRec({})
  await createDispatchCard(admin as never, recId, '')
  const pending = getToolApprovals().listPending().find(a => a.nodeId === 'optimizer-recipe:rc-d' && (a.payload as { recommendationId?: string })?.recommendationId === recId)
  assert.ok(pending, '卡已挂审批面')
  const result = await decideOptimizerDispatch({
    cardId: pending!.id, approved: true, comment: '批准测试', choice: 0,
    actingUser: { id: admin.id, name: 'Admin' }, via: 'test',
  })
  assert.equal(result.handled, true)
  assert.equal(result.approved, true)
  assert.equal(applyRecipeCalls.length, 1)
  const override = applyRecipeCalls[0]!.overrides[0]!
  assert.equal(override.nodeId, 'dw-1')
  assert.equal(override.value, 55)
  assert.equal(dispatchState(recId), 'executed')
  assert.equal(auditCount('optimizer.dispatch.execute'), 1)
  // 未建卡的建议(idle)批准 → handled=false(调用方回退通用 decide,那里 409)
  const idleRec = seedRunRec({})
  const idle = await decideOptimizerDispatch({ cardId: 'optimizer-recipe:rc-other', approved: true, comment: '', actingUser: { id: admin.id, name: 'A' }, via: 'test' })
  assert.equal(idle.handled, false)
  assert.equal(dispatchState(idleRec), 'idle')
})

test('业务拒绝:批准时门序失败(工件被换)→ 零写 + denied + comment 含码 + reject 审计', async () => {
  cleanupDispatchCards()
  // 上一下发批准落了 op 锚(≥60s 频控):本用例经 decideOptimizerDispatch 的 D13⑧ 会命中;
  // 为隔离频控,直接清空配方操作锚(测试专用路径,仅影响本进程 mock 面)
  try {
    const { resetRecipeOpAnchors } = await import('@/server/services/workshop/dcw/recipe-op-anchor')
    resetRecipeOpAnchors()
  }
  catch { /* 无该测试钩子时改用时间豁免 */ }
  const recId = seedRunRec({})
  await createDispatchCard(admin as never, recId, '')
  db.prepare('UPDATE aml_models SET artifact_hash = ? WHERE id = ?').run('d'.repeat(64), 'mdl-d')
  const pending = getToolApprovals().listPending().find(a => a.nodeId === 'optimizer-recipe:rc-d' && (a.payload as { recommendationId?: string })?.recommendationId === recId)
  const result = await decideOptimizerDispatch({ cardId: pending!.id, approved: true, comment: '', choice: 0, actingUser: { id: admin.id, name: 'Admin' }, via: 'test' })
  assert.equal(result.handled, true)
  assert.equal(result.approved, false)
  assert.ok(String(result.code).length > 0, 'comment 携带错误码')
  assert.equal(applyRecipeCalls.length, 1, '零写(漂移拒绝,不触发 applyRecipe)')
  assert.equal(dispatchState(recId), 'denied')
  assert.equal(auditCount('optimizer.dispatch.reject'), 1)
  db.prepare('UPDATE aml_models SET artifact_hash = ? WHERE id = ?').run(artifactHash, 'mdl-d')
})

test('取消先赢:撤权收敛在飞卡(cancelPendingDispatchForUser)→ cancelled', async () => {
  cleanupDispatchCards()
  try {
    const { resetRecipeOpAnchors } = await import('@/server/services/workshop/dcw/recipe-op-anchor')
    resetRecipeOpAnchors()
  }
  catch { /* 同上 */ }
  const recId = seedRunRec({})
  await createDispatchCard(admin as never, recId, '')
  const n = cancelPendingDispatchForUser(admin.id, '权限变更测试')
  assert.equal(n, 1)
  assert.equal(dispatchState(recId), 'cancelled')
  const pending = getToolApprovals().listPending().find(a => (a.payload as { recommendationId?: string })?.recommendationId === recId)
  assert.equal(pending, undefined, 'pending 已收敛')
})

test('未建卡(idle)建议不可经状态机转移(条件要求 dispatched+dispatched_at)', () => {
  const recId = seedRunRec({})
  assert.equal(dispatchState(recId), 'idle')
  const claim = db.prepare(`UPDATE optimizer_recommendations SET dispatch_state = 'committed', approval_id = 'x'
    WHERE id = ? AND dispatch_state = 'dispatched' AND dispatched_at IS NOT NULL`).run(recId)
  assert.equal(Number(claim.changes), 0, 'idle 建议的 committed 抢占 changes=0')
  assert.equal(dispatchState(recId), 'idle')
})

test('运行门(2026-10-28):产线无活动批次 → 批准被拒且零写', async () => {
  cleanupDispatchCards()
  clearActiveLineRun('ln-d')
  try {
    const recId = seedRunRec({})
    await createDispatchCard(admin as never, recId, '停线下发测试')
    const pending = getToolApprovals().listPending().find(a => a.nodeId === 'optimizer-recipe:rc-d' && (a.payload as { recommendationId?: string })?.recommendationId === recId)
    assert.ok(pending, '卡已挂审批面')
    const writesBefore = applyRecipeCalls.length
    const result = await decideOptimizerDispatch({
      cardId: pending!.id, approved: true, comment: '', choice: 0,
      actingUser: { id: admin.id, name: 'Admin' }, via: 'test',
    })
    assert.equal(result.handled, true)
    assert.equal(result.approved, false)
    assert.equal(result.code, 'DISPATCH_GATE_LINE_NOT_RUNNING')
    assert.equal(applyRecipeCalls.length, writesBefore, '停线时批准不触发 applyRecipe')
    assert.equal(dispatchState(recId), 'denied')
  }
  finally {
    startLineWindow()
  }
})

after(async () => {
  try {
    rmSync(testHome, { recursive: true, force: true })
  }
  catch { /* 并行会话可能已清理 */ }
  try {
    rmSync(modelDir, { recursive: true, force: true })
  }
  catch { /* 同上 */ }
})
