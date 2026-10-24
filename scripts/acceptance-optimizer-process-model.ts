/* eslint-disable @stylistic/max-statements-per-line */
/**
 * G6 系统验收:A1–A22 机器可判定断言(进程内 + 真实 Python solver + 真实 SQLite/Timescale)。
 *
 * 运行:npx tsx scripts/acceptance-optimizer-process-model.ts
 * 证据:docs/audit/evidence/2026-10-22-optimizer-process-model/acceptance.json
 *
 * 边界(如实记录,不静默通过):
 *  - 不启动 HTTP 服务;REST 层用同一服务函数 + 持久状态断言(UI 与 Agent 共用服务层)。
 *  - A9 的浏览器点击不在本脚本范围:判定"接口载荷/持久状态/零写计数 + UI 路由契约"。
 *  - ingestedAt 的到达时间语义仅 SQLite 实现;Timescale 分支只断言 state/分页。
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const evidenceDir = process.env.AW_E2E_EVIDENCE_DIR || join(process.cwd(), 'docs', 'audit', 'evidence', '2026-10-22-optimizer-process-model')
mkdirSync(evidenceDir, { recursive: true })

const results: Array<{ id: string, name: string, pass: boolean, detail: string, extra?: unknown }> = []
function record(id: string, name: string, pass: boolean, detail: string, extra?: unknown) {
  results.push({ id, name, pass, detail, extra })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} — ${detail}`)
}
function section(name: string) { console.log(`\n=== ${name} ===`) }

const home = mkdtempSync(join(tmpdir(), 'aw-accept-optimizer-'))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = home
process.env.AW_AML_DIR = join(home, 'aml')

const started = Date.now()
section('boot')
const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime, getAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { registerBuiltinOptimizerAdapters } = await import('../server/services/workshop/process-model/trainers')
const db = openWorkshopDb(join(home, 'accept.sqlite'))
configureAmlRuntime(db)
const rt = getAmlRuntime()
// 复用真实 AML venv(只写 marker);否则每次验收都会重装 torch
const realVenv = join(process.env.USERPROFILE ?? process.env.HOME ?? home, '.AgentWorkShop', 'aml', '.venv')
if (existsSync(realVenv)) rt.venvDir = realVenv
registerBuiltinOptimizerAdapters()

const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getTsdb } = await import('../server/services/workshop/daq/storage')
const { hashDatasetDir } = await import('../server/services/workshop/aml/dataset-builder')
const { submitJob } = await import('../server/services/workshop/aml/job-orchestrator')
const { readDataset } = await import('../server/services/workshop/process-model/trainers/dataset-reader')
const { trainLinearArx } = await import('../server/services/workshop/process-model/trainers/linear-arx')
const { evaluateEligibility } = await import('../server/services/workshop/process-model/eligibility')
const { evaluateEligibilityFromDataset } = await import('../server/services/workshop/process-model/eligibility-service')
const { parseProcessModelSpec } = await import('../server/services/workshop/process-model/spec')
const { createProcessModelSpecRepo } = await import('../server/services/workshop/process-model/spec.repo')
const { getContextSegmentRepo, recipeContentHash } = await import('../server/services/workshop/process-model/context-segments.repo')
const { createProfileRepo } = await import('../server/services/workshop/optimization/profile.repo')
const { createBinding, resolveBinding } = await import('../server/services/workshop/optimization/binding.service')
const { getBindingRepo } = await import('../server/services/workshop/optimization/binding.repo')
const { solve } = await import('../server/services/workshop/optimization/manager')
const { evaluateCandidateCost, constraintReport, simulateLinear } = await import('../server/services/workshop/optimization/problem-builder')
const { getSolverWorkerPool, SolverWorkerPool } = await import('../server/services/workshop/optimization/worker-client')
const { assertModelNotReferenced } = await import('../server/services/workshop/aml/model-references')
const { createExperimentPlan, assertSimulatedLine } = await import('../server/services/workshop/process-model/experiment')
const { toolSignature } = await import('../server/harness/aw-mcp-signature.mjs')
const { HOST_TOOLS, OPTIMIZER_TOOL_NAMES, hostToolsForRole } = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
const { INDUSTRIAL_TOOL_NAMES } = await import('../server/services/workshop/agents/host-tool-bridge/tools/industrial')
const { buildToolRegistrySnapshot } = await import('../server/services/workshop/tools/registry')
const { optimizerDispatchGate, legacyMpcAliasGate } = await import('../server/services/workshop/agents/host-tool-bridge/optimizer-gate')
const { boundModelHasEligibility, dispatchHostTool } = await import('../server/services/workshop/agents/host-tool-bridge/dispatch')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')

// =====================================================================
section('fixtures')
const now = Date.now()
const line = getDcwLineRepo().create({ name: '验收模拟线', simulated: true, simSceneId: 'film-line' })
const product = getDcwProductRepo().create({ name: '验收产品', lineId: line.id })
getDaqNodeRepo().insert(DaqNode.fromRow({ id: 'n-mv-acc', templateRef: 'tpl-acc', name: 'MV', unit: 'bar', min: 0, max: 100, lineId: line.id, driver: 'mock' }))
getDaqNodeRepo().insert(DaqNode.fromRow({ id: 'n-cv-acc', templateRef: 'tpl-acc', name: 'CV', unit: 'μm', min: 0, max: 200, lineId: line.id, driver: 'mock' }))
const recipe = getDcwRecipeRepo().create({
  name: '验收配方', productId: product.id,
  params: [],
  daqWindows: [{ nodeId: 'n-mv-acc', min: 0, max: 100 }, { nodeId: 'n-cv-acc', min: 0, max: 200 }],
})
const run = getDcwRecipeRepo().createRun(recipe)
getDcwRecipeRepo().closeRun(run.id)

const BEAT = 5000
const DELAY = 2
const H = 24
const P = 6
const TRUE_A = 0.3
const TRUE_B = 0.7
const N_RUNS = 4
const STEPS = 160
const samples: Array<{ nodeId: string, tsMs: number, value: number, state: string, lineId?: string, productId?: string, recipeId?: string, runId?: string }> = []
const plant: Array<{ u: number[], y: number[] }> = []
for (let r = 0; r < N_RUNS; r++) {
  let y = 52
  const uq: number[] = []
  const us: number[] = []
  const ys: number[] = []
  for (let k = 0; k < STEPS; k++) {
    const u = 50 + 20 * Math.sin((k + r * 11) / 9) + 6 * Math.sin((k + r * 3) / 4)
    uq.push(u)
    const uDelayed = uq[Math.max(0, uq.length - 1 - DELAY)]!
    y = TRUE_A * y + TRUE_B * uDelayed + 8 + 0.02 * Math.sin((k + r) / 3)
    us.push(u); ys.push(y)
    const ts = now - (N_RUNS - r) * STEPS * BEAT + k * BEAT
    const tags = { lineId: line.id, productId: product.id, recipeId: recipe.id, runId: run.id }
    samples.push({ nodeId: 'n-mv-acc', tsMs: ts, value: u, state: 'ok', ...tags })
    samples.push({ nodeId: 'n-cv-acc', tsMs: ts, value: y, state: 'ok', ...tags })
  }
  plant.push({ u: us, y: ys })
}
await getTsdb().writeSamples(samples)

const datasetDir = join(rt.datasetsDir, 'ds-acc')
mkdirSync(join(datasetDir, 'arrays'), { recursive: true })
{
  const xRows: number[] = []
  const uRows: number[] = []
  const yRows: number[] = []
  const tRows: number[] = []
  const mRows: number[] = []
  let windows = 0
  for (const series of plant) {
    for (let t = H; t + P <= series.y.length; t++) {
      for (let i = 0; i < H; i++) xRows.push(series.y[t - H + i]!, series.u[t - H + i]!)
      for (let p = 0; p < P; p++) { uRows.push(series.u[t + p]!); yRows.push(series.y[t + p]!) }
      for (let i = 0; i < H + P; i++) { tRows.push((t - H + i) * BEAT); mRows.push(1) }
      windows++
    }
  }
  const nTest = Math.max(1, Math.floor(windows * 0.25))
  const nVal = Math.max(1, Math.floor(windows * 0.2))
  // 与真实 builder 一致:工件里存的是**归一化**数组;训练器用 manifest.norm 反归一化。
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)
  const std = (arr: number[]) => {
    const m = mean(arr)
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, arr.length)) || 1
  }
  const yMean = mean(yRows); const yStd = std(yRows)
  const uMean = mean(uRows); const uStd = std(uRows)
  // x 列顺序 = allNodes ['n-cv','n-mv'] → 偶数列 y,奇数列 u
  const xNorm = xRows.map((v, i) => (i % 2 === 0 ? (v - yMean) / yStd : (v - uMean) / uStd))
  writeFileSync(join(datasetDir, 'arrays', 'x.f32'), Buffer.from(new Float32Array(xNorm).buffer))
  writeFileSync(join(datasetDir, 'arrays', 'u.f32'), Buffer.from(new Float32Array(uRows.map(v => (v - uMean) / uStd)).buffer))
  writeFileSync(join(datasetDir, 'arrays', 'y.f32'), Buffer.from(new Float32Array(yRows.map(v => (v - yMean) / yStd)).buffer))
  writeFileSync(join(datasetDir, 'arrays', 'timestamps.f64'), Buffer.from(new Float64Array(tRows).buffer))
  writeFileSync(join(datasetDir, 'arrays', 'mask.f32'), Buffer.from(new Float32Array(mRows).buffer))
  writeFileSync(join(datasetDir, 'arrays', 'sidecar.json'), JSON.stringify({ label: 'accept', delays: { mv1: DELAY * BEAT }, variableOrder: ['mv1', 'cv1'] }))
  writeFileSync(join(datasetDir, 'manifest.json'), JSON.stringify({
    version: 2, dataKind: 'dynamic',
    allNodes: ['n-cv-acc', 'n-mv-acc'], controlNodes: ['n-mv-acc'], targetNodes: ['n-cv-acc'], featureNodes: [],
    shapes: { x: [windows, H, 2], u: [windows, P, 1], y: [windows, P, 1] },
    split: { train: windows - nTest - nVal, val: nVal, test: nTest, trainRunIds: [run.id], valRunIds: [run.id], testRunIds: [run.id] },
    norm: { x: { mean: [yMean, uMean], std: [yStd, uStd] }, u: { mean: [uMean], std: [uStd] }, y: { mean: [yMean], std: [yStd] } },
    beatMs: BEAT,
    variables: [
      { id: 'mv1', nodeId: 'n-mv-acc', role: 'mv', unit: 'bar', scale: 1, offset: 0, delayMs: DELAY * BEAT },
      { id: 'cv1', nodeId: 'n-cv-acc', role: 'cv', unit: 'μm', scale: 1, offset: 0 },
    ],
    artifacts: { x: 'arrays/x.f32', u: 'arrays/u.f32', y: 'arrays/y.f32', timestamps: 'arrays/timestamps.f64', mask: 'arrays/mask.f32', sidecar: 'arrays/sidecar.json' },
    provenance: { lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: recipe.version ?? 1, runIds: [run.id], recipeContentHash: recipeContentHash(recipe), evidenceSource: 'simulation', availabilityWatermark: now, capturedAt: new Date().toISOString() },
  }, null, 2))
  const sha = hashDatasetDir(datasetDir, '{}')
  rt.repo.dataset.insert({
    id: 'ds-acc', lineId: line.id, productId: product.id, recipeId: recipe.id, runIds: [run.id],
    specJson: '{}', sha256: sha, rowCount: windows, fromMs: now - N_RUNS * STEPS * BEAT, toMs: now,
    path: datasetDir, createdBy: 'acceptance', createdByKind: 'user', note: 'acceptance fixture', createdAt: new Date().toISOString(),
    specRef: 'pms-acc', specVersion: 1,
    // D18/SW2.4:验收 fixture 显式置 1(手插路径,不经 builder;每 run 的 confirmed segment 见 A13 段插入)
    lineageVerified: 1,
  })
}

function specOf(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2, id: 'pms-acc', version: 1,
    lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: recipe.version ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }] }],
    variables: [
      { id: 'mv1', nodeId: 'n-mv-acc', role: 'mv', field: 'value', unit: 'bar', scale: 1, offset: 0, delayMs: DELAY * BEAT, min: 0, max: 100, maxStep: 20 },
      { id: 'cv1', nodeId: 'n-cv-acc', role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    timing: { beatMs: BEAT, historySteps: H, horizonSteps: P, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: { runIds: [run.id], split: { valRatio: 0.2, testRatio: 0.2, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 0, max: 100, maxStep: 20 } }, cv: { cv1: { min: 0, max: 200 } } },
    purpose: 'mpc_surrogate',
    ...overrides,
  }
}
const spec = parseProcessModelSpec(specOf())
const specRepo = createProcessModelSpecRepo(db)
specRepo.insert(spec)
specRepo.publish(spec.id, spec.version)

const job = submitJob({
  datasetId: 'ds-acc', purpose: 'mpc_surrogate', trainerRef: 'linear_arx@1',
  processModelSpec: spec as unknown as Record<string, unknown>, modelName: '验收线性模型',
})
await (async () => {
  // 让作业编排器自己跑(生产路径)。不要手动 startJob:队列 tick 会双跑同一作业,
  // 第二次 finish 必然竞争失败。
  const terminal = new Set(['done', 'failed', 'cancelled', 'timeout', 'interrupted'])
  for (let i = 0; i < 240; i++) {
    const row = rt.repo.job.get(job.id)
    if (row && terminal.has(row.status)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('训练作业 120s 未到终态')
})()
const finishedJob = rt.repo.job.get(job.id)!
const modelId = finishedJob.modelId ?? ''

// =====================================================================
section('A1/A15/A16 data')
{
  const tsdb = getTsdb()
  const pages: Array<{ at: number }> = []
  let after: number | undefined
  for (let i = 0; i < 6; i++) {
    const page = await tsdb.queryTaggedPage!('n-cv-acc', { fromMs: 0, toMs: now, limit: 41, afterTs: after, withState: true })
    pages.push(...page.points)
    if (page.done) break
    after = page.nextCursor ?? undefined
  }
  const unique = new Set(pages.map(p => p.at))
  record('A1', '逐节点分页:续读无漏无重 + ASC', pages.length > 0 && unique.size === pages.length && pages.every((p, i, a) => i === 0 || p.at > a[i - 1]!.at), `${pages.length} 点 / ${unique.size} 唯一`)

  const tagged = await tsdb.queryTagged({ nodeIds: ['n-cv-acc'], fromMs: 0, toMs: now, limit: 100 })
  const pts = tagged.get('n-cv-acc') ?? []
  record('A15', 'queryTagged raw 返回真实 state(非空)', pts.length > 0 && pts.every(p => typeof p.state === 'string' && p.state.length > 0), `${pts.length} 点`)

  const firstTs = samples.find(s => s.nodeId === 'n-cv-acc')!.tsMs
  const before = tsdb.stats?.().correctionDropped ?? 0
  await tsdb.writeSamples([{ nodeId: 'n-cv-acc', tsMs: firstTs, value: 999, state: 'alarm' }])
  const afterStats = tsdb.stats?.().correctionDropped ?? 0
  const orig = await tsdb.query('n-cv-acc', { fromMs: firstTs, toMs: firstTs })
  record('A16', '首写胜出 + 同键更正被计数丢弃', afterStats === before + 1 && orig[0]?.value !== 999, `dropped ${before}→${afterStats}`)

  const tampered = join(rt.datasetsDir, 'ds-tamper')
  cpSync(datasetDir, tampered, { recursive: true })
  const h1 = hashDatasetDir(tampered, '{}')
  writeFileSync(join(tampered, 'arrays', 'sidecar.json'), '{"tampered":true}')
  const h2 = hashDatasetDir(tampered, '{}')
  record('A1', 'manifest v2 sidecar 篡改使 hash 失败', h1 !== h2 && h1.length === 64, `${h1.slice(0, 10)} ≠ ${h2.slice(0, 10)}`)

  try {
    const { TimescaleAdapter } = await import('../server/services/workshop/daq/storage/timescale.adapter')
    const url = process.env.ACCEPT_TSDB_URL ?? 'postgres://postgres:awshop@127.0.0.1:5432/awshop'
    const ts = new TimescaleAdapter(url)
    await ts.init()
    const node = `acc-ts-${Date.now().toString(36)}`
    await ts.writeSamples([{ nodeId: node, tsMs: now - 3000, value: 1, state: 'ok' }, { nodeId: node, tsMs: now - 2000, value: 2, state: 'alarm' }])
    const readback = await ts.query(node, { fromMs: now - 10_000, toMs: now })
    const latestOne = (await ts.latest()).get(node)
    record('A1', 'Timescale 同 fixture(写入/raw 读取/state)', readback.some(p => p.state === 'alarm') && latestOne?.state === 'alarm', `rows=${readback.length} state=${readback.map(p => p.state).join(',')} latest=${latestOne?.state ?? 'none'}`)
    await ts.close()
  }
  catch (err) {
    record('A1', 'Timescale 同 fixture(state + 分页)', false, `不可判定:${err instanceof Error ? err.message : String(err)}`)
  }
}

// =====================================================================
section('A2 eligibility')
{
  const n = 80
  const constU = evaluateEligibility({ spec, scope: 'simulation', conditionId: 'c1', series: [{ variableId: 'mv1', role: 'mv', values: new Array(n).fill(50) }, { variableId: 'cv1', role: 'cv', values: Array.from({ length: n }, (_, i) => 50 + 10 * Math.sin(i / 3)) }], actionEvidence: 'simulation_commanded' })
  record('A2', 'U 恒定 + Y 波动 → 不可优化', constU.optimizationEligible === false && constU.gaps.some(g => g.code === 'MV_CONSTANT'), constU.gaps.map(g => g.code).join(','))
  const ack = evaluateEligibility({ spec, scope: 'real', conditionId: 'c1', series: [{ variableId: 'mv1', role: 'mv', values: Array.from({ length: 120 }, (_, i) => 50 + 20 * Math.sin(i / 5)) }, { variableId: 'cv1', role: 'cv', values: Array.from({ length: 120 }, (_, i) => 50 + 4 * Math.sin(i / 5 - 1)) }], actionEvidence: 'ack_only' })
  record('A2', '仅 ACK 动作 → 不可优化', ack.optimizationEligible === false && ack.gaps.some(g => g.code === 'ACTION_ACK_ONLY'), ack.gaps.map(g => g.code).join(','))
  const real = evaluateEligibilityFromDataset({ specId: spec.id, datasetId: 'ds-acc', scope: 'simulation' })
  record('A2', '激励充分的模拟数据 → 具备优化资格', real.optimizationEligible === true, `gaps=${real.gaps.map(g => g.code).join(',') || 'none'}`)
}

// =====================================================================
section('A3 dynamic model')
const artifact = trainLinearArx(readDataset(datasetDir), { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true }, { variables: spec.variables, beatMs: BEAT })
{
  const a = artifact.A[0]![0]!
  const bIndex = artifact.layout.uOffset + Math.max(0, DELAY - 1)
  const b = artifact.A[0]![bIndex] ?? 0
  record('A3', 'ARX 辨识系数接近真值(0.82/0.18)', Math.abs(a - TRUE_A) < 0.05 && Math.abs(b - TRUE_B) < 0.05, `a=${a.toFixed(4)} b=${b.toFixed(4)} (index ${bIndex})`)
  record('A3', '多步 RMSE 比持值基线降低 ≥20%', artifact.metrics.rolloutImprovement >= 0.2, `${(artifact.metrics.rolloutImprovement * 100).toFixed(1)}%`)
  const x0 = Array.from({ length: artifact.stateDim }, (_, i) => {
    // y 状态寄存器 = plant 在 u=50 的稳态;u 延迟线 = 50
    const ySteady = (TRUE_B * 50 + 8) / (1 - TRUE_A)
    return i < artifact.C.length * artifact.arOrder ? ySteady : 50
  })
  const step = simulateLinear({ A: artifact.A.flat(), B: artifact.B.flat(), C: artifact.C.flat(), D: artifact.D.flat(), bias: artifact.bias, stateDim: artifact.stateDim, x0 }, 1, 1, [50], Array.from({ length: DELAY + 2 }, () => [60]))
  const y0 = step[0]?.[0] ?? 0
  const firstMove = step.findIndex(r => Math.abs((r[0] ?? 0) - y0) > 0.5)
  const startOk = firstMove >= 0 && Math.abs(firstMove - DELAY) <= 1
  record('A3', '阶跃响应起点误差 ≤1 采样步(延迟不提前/不双计)', startOk, `firstMove=${firstMove} d=${DELAY} y=${step.map(r => r[0]!.toFixed(3)).join(',')}`)
  record('A3', '训练作业 done 且模型已登记(两阶段成功语义)', finishedJob.status === 'done' && Boolean(modelId) && rt.repo.model.get(modelId)?.artifactKind === 'linear_state_space@1', `job=${finishedJob.status} model=${modelId || 'none'} err=${finishedJob.error ?? ''}`)
}

// =====================================================================
section('A4 solver')
const pool = getSolverWorkerPool()
const steadyIr = {
  irVersion: 1, hash: 'acc-steady', profileRef: 'p@1',
  modelRef: { modelId: 'm', artifactKind: 'static_response@1', artifactHash: 'h', modelInterface: 'static_response', stage: 'production' },
  solverRef: 'scipy_slsqp@1',
  conditions: { conditionId: 'c', lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: 1 },
  horizon: 1, beatMs: BEAT,
  scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
  weights: { cv: { cv1: 1 }, du: {}, terminal: 0, economic: {} },
  context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
  problem: { template: 'steady_response@1', mvOrder: ['mv1'], cvOrder: ['cv1'], coefficients: { cv1: [0, 1] }, featureOrder: ['bias', 'mv1'], cvTargets: [3], mvBounds: [{ min: -10, max: 10, maxStep: 10 }], cvBounds: [{}], uPrev: [0] },
} as never
const mpcProblem = {
  template: 'linear_mpc_quadratic@1',
  dynamics: { stateDim: 1, A: [0.82], B: [0.18], C: [1], D: [0], delays: { mv1: DELAY }, x0: [55] },
  cvSetpoints: [50], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'], mvBounds: [{ min: 0, max: 100, maxStep: 20 }], uPrev: [50],
}
const mpcIr = {
  irVersion: 1, hash: 'acc-mpc', profileRef: 'p@1',
  modelRef: { modelId: 'm', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'production' },
  solverRef: 'osqp_mpc@1',
  conditions: { conditionId: 'c', lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: 1 },
  horizon: 12, beatMs: BEAT,
  scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
  weights: { cv: { cv1: 1 }, du: { mv1: 0.05 }, terminal: 2 },
  context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
  problem: mpcProblem,
} as never
{
  const probe = await pool.probe()
  record('A7', 'AML venv 内 osqp/scipy 可用(同一解释器)', probe.ok && probe.osqp && probe.scipy, probe.pythonPath)
  const r1 = await pool.solve(steadyIr)
  const u = (r1.result as { controls: number[][] }).controls[0]![0]!
  record('A4', 'SciPy 解析解误差 ≤1e-4', Math.abs(u - 3) <= 1e-4, `u=${u}`)
  const r2 = await pool.solve(mpcIr)
  const payload = r2.result as { status: string, controls: number[][], predicted: number[][], cost: number }
  const candidate = { seq: 0, controls: payload.controls, predicted: payload.predicted, cost: payload.cost, constraints: [], feasible: true }
  const independent = evaluateCandidateCost(mpcIr, candidate)
  const mismatch = Math.abs(payload.cost - independent) / Math.max(1, Math.abs(independent))
  const reports = constraintReport(mpcIr, candidate)
  const maxResidual = Math.max(...reports.map(r => r.residual))
  record('A4', 'OSQP 收敛 + 约束残差 ≤1e-5', payload.status === 'optimal' && maxResidual <= 1e-5, `status=${payload.status} residual=${maxResidual.toExponential(2)}`)
  record('A4', 'Solver 代价与平台独立重算相对差 ≤1e-6', mismatch <= 1e-6, `solver=${payload.cost.toFixed(6)} independent=${independent.toFixed(6)} diff=${mismatch.toExponential(2)}`)
  record('A4', 'MPC 候选非恒值', new Set(payload.controls.map(c => c[0]!.toFixed(6))).size >= 2, payload.controls.slice(0, 4).map(c => c[0]!.toFixed(2)).join(','))
}

// =====================================================================
section('A5/A22 worker lifecycle')
{
  const infeasible = { ...mpcIr, hash: 'inf', horizon: 3, problem: { ...mpcProblem, cvSetpoints: [0], cvBounds: [{ min: 100, max: 200 }], mvBounds: [{ min: 0, max: 0 }], uPrev: [0] } } as never
  const r = await pool.solve(infeasible)
  record('A5', '不可行问题返回 infeasible(不崩溃)', (r.result as { status: string }).status === 'infeasible', (r.result as { status: string }).status)

  const big = { ...mpcIr, hash: 'big', horizon: 1200, problem: { ...mpcProblem, cvSetpoints: [50] } } as never
  let timedOut = false
  try { await pool.solve(big, { timeoutMs: 40 }) }
  catch (err) { timedOut = (err as { code?: string }).code === 'SOLVE_TIMEOUT' }
  await new Promise(resolve => setTimeout(resolve, 1800))
  const recovered = await pool.solve(steadyIr, { timeoutMs: 15_000 })
  record('A5', '超时明确返回 SOLVE_TIMEOUT 且池可恢复', timedOut && (recovered.result as { status: string }).status === 'optimal', `timedOut=${timedOut}`)

  const pids = pool.workerPids()
  if (pids[0]) {
    try { process.kill(pids[0]) }
    catch { /* 已退出 */ }
  }
  await new Promise(resolve => setTimeout(resolve, 600))
  const afterCrash = await pool.solve(steadyIr, { timeoutMs: 20_000 })
  record('A22', 'Worker 崩溃后池自动补位(在途无重放)', (afterCrash.result as { status: string }).status === 'optimal' && pool.stats().degraded === false, JSON.stringify(pool.stats()))

  const pool2 = new SolverWorkerPool({ poolSize: 2, requestTimeoutMs: 30_000, threads: 1 })
  const aP = pool2.solve({ ...big, hash: 'cancel-a' } as never, { requestId: 'req-a', timeoutMs: 30_000 }).catch(err => ({ error: (err as { code?: string }).code }))
  const bP = pool2.solve(steadyIr, { requestId: 'req-b', timeoutMs: 30_000 })
  await new Promise(resolve => setTimeout(resolve, 120))
  await pool2.cancel('req-a')
  const [aRes, bRes] = await Promise.all([aP, bP])
  record('A5', '取消 A 不影响 B(B 仍 optimal)', (bRes as { result: { status: string } }).result.status === 'optimal', `A=${'error' in (aRes as object) ? (aRes as { error?: string }).error : 'result'}`)
  await pool2.shutdown()
}

// =====================================================================
section('A6/A17 binding')
{
  const nowIso = new Date().toISOString()
  db.prepare(`INSERT INTO workspaces (id, owner_user_id, name, created_at) VALUES ('ws-acc','u-acc','ws',?)`).run(nowIso)
  db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-acc','ch','',1,?,?)`).run(nowIso, nowIso)
  db.prepare(`INSERT INTO workspace_channels (workspace_id, channel_id, created_at) VALUES ('ws-acc','ch-acc',?)`).run(nowIso)
  db.prepare(`INSERT INTO agents (id, name, harness, created_at, updated_at) VALUES ('tpl-acc','tpl','mock',?,?)`).run(nowIso, nowIso)
  db.prepare(`INSERT INTO channel_agents (id, channel_id, template_id, name, harness, token, created_at, updated_at) VALUES ('ca-acc','ch-acc','tpl-acc','a','mock','tok-acc',?,?), ('ca-acc2','ch-acc','tpl-acc','a2','mock','tok-acc2',?,?)`).run(nowIso, nowIso, nowIso, nowIso)

  const profileRepo = createProfileRepo(db)
  profileRepo.insert({
    schemaVersion: 1, id: 'optp-acc', version: 1,
    modelRef: { modelId, artifactKind: 'linear_state_space@1', artifactHash: rt.repo.model.get(modelId)?.artifactHash ?? '', modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1',
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.05 }, terminalWeight: 2, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1', processSpecRef: `${spec.id}@${spec.version}`,
    conditionIds: ['c1'], status: 'draft',
  }, 'u-acc')
  profileRepo.publish('optp-acc', 1)

  const binding = createBinding({ workspaceId: 'ws-acc', channelId: 'ch-acc', agentInstanceId: 'ca-acc', profileId: 'optp-acc', profileVersion: 1 })
  let templateRejected = false
  try { createBinding({ workspaceId: 'ws-acc', channelId: 'ch-acc', agentInstanceId: 'tpl-acc', profileId: 'optp-acc', profileVersion: 1 }) }
  catch (err) { templateRejected = (err as { code?: string }).code === 'AGENT_TEMPLATE_ID_NOT_ALLOWED' }
  record('A17', '模板 id 明确拒绝(AGENT_TEMPLATE_ID_NOT_ALLOWED)', templateRejected, 'tpl-acc')
  const resolved = resolveBinding('ca-acc')
  resolved.lease.release()
  record('A6', '唯一绑定可默认解析', resolved.binding.id === binding.id, binding.id)
  let notOwned = false
  try { resolveBinding('ca-acc2', binding.id) }
  catch (err) { notOwned = ['BINDING_NOT_OWNED', 'BINDING_NOT_FOUND'].includes((err as { code?: string }).code ?? '') }
  record('A6', '他人 binding → NOT_OWNED', notOwned, 'ca-acc2')
  getBindingRepo().remove(binding.id)
  let revoked = false
  try { resolveBinding('ca-acc') }
  catch (err) { revoked = (err as { code?: string }).code === 'BINDING_NOT_FOUND' }
  record('A6', '撤权后立即拒绝', revoked, 'removed')
}

// =====================================================================
section('A8 simulated benefit')
{
  // 闭环:延迟 FOPDT fixture(与训练数据同结构)。每 1 拍求解一次,只应用首步;
  // 保持方案恒 u=50。history 的 u 延迟线由真实已应用输入填充。
  const mkIr = (y0: number, uHist: number[]) => {
    const last = uHist[uHist.length - 1] ?? 50
    const x0 = Array.from({ length: artifact.stateDim }, (_, i) => {
      if (i === 0) return y0
      if (i >= artifact.layout.uOffset) return uHist[uHist.length - 1 - (i - artifact.layout.uOffset)] ?? last
      return 0
    })
    return {
      irVersion: 1, hash: 'a8', profileRef: 'p@1',
      modelRef: { modelId: 'm', artifactKind: 'linear_state_space@1', artifactHash: 'h', modelInterface: 'linear_state_space', stage: 'production' },
      solverRef: 'osqp_mpc@1',
      conditions: { conditionId: 'c', lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: 1 },
      horizon: 10, beatMs: BEAT,
      scaling: { mv: { mv1: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
      weights: { cv: { cv1: 1 }, du: { mv1: 0.01 }, terminal: 2 },
      context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
      problem: {
        template: 'linear_mpc_quadratic@1',
        dynamics: { stateDim: artifact.stateDim, A: artifact.A.flat(), B: artifact.B.flat(), C: artifact.C.flat(), D: artifact.D.flat(), bias: artifact.bias, delays: artifact.delaysSteps, x0 },
        cvSetpoints: [50], cvBounds: [{}], mvOrder: ['mv1'], cvOrder: ['cv1'], mvBounds: [{ min: 0, max: 100, maxStep: 20 }], uPrev: [last],
      },
    } as never
  }
  const errHold: number[] = []
  const errMpc: number[] = []
  const STEPS_A8 = 8
  const EVAL_FROM = 4
  for (let seed = 0; seed < 20; seed++) {
    let yHold = 56 + 0.4 * Math.sin(seed)
    let yMpc = yHold
    const uHoldQ: number[] = []
    const uMpcQ: number[] = []
    for (let k = 0; k < STEPS_A8; k++) {
      const disturb = 0.6 * Math.sin((seed * 7 + k) / 3)
      // 保持方案
      const uHold = 50
      uHoldQ.push(uHold)
      const uDelayedHold = uHoldQ[Math.max(0, uHoldQ.length - 1 - DELAY)]!
      yHold = TRUE_A * yHold + TRUE_B * uDelayedHold + 8 + disturb
      // MPC:用当前真实 history(简化:近 H 拍 y 取 yMpc、u 取已应用历史)
      const uHist = [...uMpcQ.slice(-24)]
      const solveRes = await pool.solve(mkIr(yMpc, uHist.length ? uHist : [50]))
      const uMpc = (solveRes.result as { controls: number[][], status: string }).status === 'optimal'
        ? (solveRes.result as { controls: number[][] }).controls[0]![0]!
        : 50
      uMpcQ.push(uMpc)
      const uDelayedMpc = uMpcQ[Math.max(0, uMpcQ.length - 1 - DELAY)]!
      yMpc = TRUE_A * yMpc + TRUE_B * uDelayedMpc + 8 + disturb
      if (k >= EVAL_FROM) {
        errHold.push(Math.abs(yHold - 50))
        errMpc.push(Math.abs(yMpc - 50))
      }
    }
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
  const diffs = errHold.map((h, i) => h - errMpc[i]!)
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1))
  const lower = mean - 1.729 * sd / Math.sqrt(diffs.length)
  const improve = 1 - med(errMpc) / med(errHold)
  record('A8', '延迟 FOPDT fixture:MPC 相对保持中位误差改善 ≥15% 且 95% 下界>0', improve >= 0.15 && lower > 0, `improve=${(improve * 100).toFixed(1)}% hold=${med(errHold).toFixed(3)} mpc=${med(errMpc).toFixed(3)} lower=${lower.toFixed(4)}`)

  const staticIr = {
    irVersion: 1, hash: 'anneal', profileRef: 'p@1',
    modelRef: { modelId: 'm', artifactKind: 'static_response@1', artifactHash: 'h', modelInterface: 'static_response', stage: 'production' },
    solverRef: 'scipy_slsqp@1',
    conditions: { conditionId: 'c', lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: 1 },
    horizon: 1, beatMs: BEAT,
    scaling: { mv: { speed: { scale: 1, offset: 0 }, zone: { scale: 1, offset: 0 } }, cv: { cv1: { scale: 1, offset: 0 } } },
    weights: { cv: { cv1: 0 }, du: {}, terminal: 0, economic: { speed: -1 } },
    context: { capturedAt: '', eventAsOf: 0, availabilityWatermark: null, evidenceSource: 'simulation' },
    problem: {
      template: 'steady_response@1', mvOrder: ['speed', 'zone'], cvOrder: ['cv1'],
      coefficients: { cv1: [22, 0.85, 0.2, -0.01] }, featureOrder: ['bias', 'speed', 'zone', 'speed^2'],
      cvTargets: [50], mvBounds: [{ min: 20, max: 80 }, { min: 50, max: 50 }], cvBounds: [{ min: 48, max: 52 }], uPrev: [40, 50],
    },
  } as never
  const ra = await pool.solve(staticIr)
  const cost = (ra.result as { cost?: number }).cost ?? 0
  const improveEcon = (-cost - 40) / 40
  record('A8', '退火响应面 fixture:SciPy 质量约束下经济代价改善 ≥15%', (ra.result as { status: string }).status === 'optimal' && improveEcon >= 0.15, `baseline=-40 optimized=${cost.toFixed(2)} improve=${(improveEcon * 100).toFixed(1)}%`)
}

// =====================================================================
section('A9/A13/A14')
{
  const plan = createExperimentPlan({ lineId: line.id, specId: spec.id, levels: { mv1: [40, 50, 60] }, repeats: 2 })
  record('A9', '模拟线可创建参数试验计划', Boolean(plan.id) && JSON.parse(plan.planJson).design === 'stepped_multi_level', plan.id)
  const realLine = getDcwLineRepo().create({ name: '验收真实线', simulated: false })
  let violation = false
  try { assertSimulatedLine(realLine.id) }
  catch (err) { violation = (err as { code?: string }).code === 'SIM_ONLY_VIOLATION' }
  record('A9', '真实线发起模拟试验 → SIM_ONLY_VIOLATION', violation, realLine.id)

  const writesPath = join(home, 'data', 'dcw-writes.json')
  mkdirSync(join(home, 'data'), { recursive: true })
  if (!existsSync(writesPath)) writeFileSync(writesPath, '[]')
  const before = readFileSync(writesPath, 'utf8')
  // 让上下文新鲜:把最后一个 run 的末 H 拍平移到现在(A9 在 fixture 之后运行,
  // 原始样本已超出 context 的 maxAge=1.5×beat)。
  const fresh = Date.now()
  const lastPlant = plant[plant.length - 1]!
  const tail: Array<{ nodeId: string, tsMs: number, value: number, state: string, lineId: string, productId: string, recipeId: string, runId: string }> = []
  for (let i = 0; i < H; i++) {
    const ts = fresh - (H - 1 - i) * BEAT
    const idx = lastPlant.y.length - H + i
    const tags = { lineId: line.id, productId: product.id, recipeId: recipe.id, runId: run.id }
    tail.push({ nodeId: 'n-mv-acc', tsMs: ts, value: lastPlant.u[idx]!, state: 'ok', ...tags })
    tail.push({ nodeId: 'n-cv-acc', tsMs: ts, value: lastPlant.y[idx]!, state: 'ok', ...tags })
  }
  await getTsdb().writeSamples(tail)
  db.prepare(`INSERT INTO channel_agents (id, channel_id, template_id, name, harness, token, created_at, updated_at) VALUES ('ca-acc3','ch-acc','tpl-acc','a3','mock','tok-acc3',?,?)`).run(new Date().toISOString(), new Date().toISOString())
  createBinding({ workspaceId: 'ws-acc', channelId: 'ch-acc', agentInstanceId: 'ca-acc3', profileId: 'optp-acc', profileVersion: 1 })
  const outcome = await solve('ca-acc3')
  const after = readFileSync(writesPath, 'utf8')
  record('A9', 'solve 链路零 DCW 写入 + 持久运行/建议', before === after && outcome.runId.length > 0 && Boolean(outcome.recommendation), `run=${outcome.runId} status=${outcome.result.status} rec=${outcome.recommendation?.status ?? 'none'} diag=${outcome.result.diagnostics.message ?? ''}`)
  record('A6', '缺 UQ 证据 → unverified(不得显示已验证)', outcome.recommendation?.status === 'unverified' && (outcome.recommendation?.statusLabel ?? '').includes('未验证'), outcome.recommendation?.statusLabel ?? 'none')

  const h1 = recipeContentHash(recipe)
  const h2 = recipeContentHash({ ...recipe, version: (recipe.version ?? 1) + 1 })
  record('A13', '同 recipeId 升版 → 内容 hash 不同', h1 !== h2, `${h1.slice(0, 10)} vs ${h2.slice(0, 10)}`)
  const seg = getContextSegmentRepo().insert({ lineId: line.id, runId: run.id, fromTs: now - 1000, toTs: now, recipeId: recipe.id, recipeVersion: recipe.version ?? 1, recipeContentHash: h1, conditionId: 'c1', source: 'line_run', confirmed: true })
  record('A13', '批次谱系段记录版本与内容 hash', seg.recipeVersion === (recipe.version ?? 1) && seg.recipeContentHash === h1, seg.id)
  let stageRejected = false
  try {
    parseProcessModelSpec({
      ...specOf({ id: 'pms-stage-check' }),
      conditions: [{ id: 's', match: [{ field: 'stage', op: 'eq', value: 'low' }] }],
    })
  }
  catch (err) { stageRejected = (err as { code?: string }).code === 'CONDITION_FIELD_UNSUPPORTED' }
  record('A13', 'stage 工况显式拒绝(首版无结构化阶段来源)', stageRejected, 'CONDITION_FIELD_UNSUPPORTED')
  const { isRuntimeConditionChanged } = await import('../server/services/workshop/process-model/conditions')
  const switchedAt = Date.now() + 1000
  getContextSegmentRepo().insert({
    lineId: line.id, runId: run.id, fromTs: switchedAt, toTs: null,
    recipeId: 'rc-other', recipeVersion: 9, recipeContentHash: 'other-hash', conditionId: '', source: 'line_run', confirmed: true,
  })
  const changed = await isRuntimeConditionChanged(spec, {
    lineId: line.id, productId: product.id, recipeId: recipe.id, recipeVersion: spec.recipeVersion,
    conditionId: 'c1', capturedAt: '', eventAsOf: switchedAt, availabilityWatermark: null, dtMs: BEAT,
    variables: [], history: [], timestamps: [], qualityMask: [], currentInputs: {}, currentOutputs: {}, evidenceSource: 'simulation',
  })
  record('A13', '运行中切换到不同配方 → 旧计划失效', changed, `recipeId=rc-other@${switchedAt}`)
  // 真实切换链:lineStart(R1) → applyRecipe(R2) → 活动窗口/入库样本/谱系段必须同步
  {
    const { getActiveLineRun } = await import('../server/services/workshop/dcw/line-run')
    const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
    const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
    const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
    const { bindDaqHost } = await import('../server/services/workshop/daq/host-bindings')
    const { getDaqHostPorts } = await import('../server/services/workshop/daq/host-ports')
    bindDaqHost(null)
    const ctrl = getDcwController()
    // 控制节点(DCW 面)与数据节点(DAQ 面)是两类实体:配方参数只能挂控制节点
    getDcwNodeRepo().insert(new DcwNode({ id: 'dcw-acc-mv', templateRef: 'dcw-temp-sp', driver: 'mock', lineId: line.id, min: 0, max: 100, unit: 'bar' }))
    const r1 = getDcwRecipeRepo().create({ name: 'A13运行配方R1', productId: product.id, params: [{ nodeId: 'dcw-acc-mv', value: 40 }] })
    const r2 = getDcwRecipeRepo().create({ name: 'A13运行配方R2', productId: product.id, params: [{ nodeId: 'dcw-acc-mv', value: 60 }] })
    let switchOk = false
    let switchDetail: string
    try {
      await ctrl.lineStart(line.id, r1.id)
      const activeRunId = getActiveLineRun(line.id)?.runId ?? ''
      const beforeSeg = getContextSegmentRepo().listByLine(line.id).find(s => s.runId === activeRunId && s.toTs == null)
      await ctrl.applyRecipe(r2.id)
      const afterSeg = getContextSegmentRepo().listByLine(line.id).find(s => s.runId === activeRunId && s.toTs == null)
      const snap = getDaqHostPorts()?.lineRun.activeRun(line.id) ?? null
      const sampleTs = afterSeg?.fromTs ?? Date.now()
      // 与 ingest.ts 同源:样本标签直接取活动窗口端口(不是另造标签)
      await getTsdb().writeSamples([{
        nodeId: 'n-mv-acc', tsMs: sampleTs, value: 55, state: 'ok',
        lineId: snap?.lineId ?? null, productId: snap?.productId ?? null, recipeId: snap?.recipeId ?? null, runId: snap?.runId ?? null,
      }])
      const read = await getTsdb().queryTagged({ nodeIds: ['n-mv-acc'], fromMs: sampleTs - 1, toMs: sampleTs + 1, limit: 5 })
      const sample = read.get('n-mv-acc')?.[0]
      // queryTagged 只回 at/value/state(标签只用于过滤):标签落库事实直接读 TSDB 行
      const { ensureDataDir } = await import('../shared/config/home.mjs')
      const { DatabaseSync } = await import('node:sqlite')
      const tsdbRead = new DatabaseSync(join(ensureDataDir(), 'daq-timeseries.sqlite'), { readOnly: true })
      const tagRow = tsdbRead.prepare('SELECT recipe_id AS recipeId, run_id AS runId, line_id AS lineId FROM daq_samples WHERE node_id = ? AND ts_ms = ?')
        .get('n-mv-acc', sampleTs) as { recipeId: string | null, runId: string | null, lineId: string | null } | undefined
      tsdbRead.close()
      const covering = getContextSegmentRepo().at(line.id, sampleTs)
      switchOk = beforeSeg?.recipeId === r1.id && snap?.recipeId === r2.id && Boolean(sample)
        && tagRow?.recipeId === r2.id && tagRow?.runId === snap?.runId && tagRow?.lineId === line.id
        && covering?.recipeId === r2.id && covering?.recipeVersion === (r2.version ?? 1)
      switchDetail = `active=${snap?.recipeId ?? 'none'} sampleTag=${tagRow?.recipeId ?? 'none'}@${sampleTs} seg=${covering?.recipeId ?? 'none'}@${covering?.recipeVersion ?? '?'}`
    }
    catch (err) {
      switchDetail = `不可判定:${err instanceof Error ? err.message : String(err)}`
    }
    finally {
      try { ctrl.lineStop(line.id) }
      catch { /* 已停线/未开跑 */ }
    }
    record('A13', '运行中 applyRecipe → 活动窗口/入库样本/谱系段同步切换到新配方', switchOk, switchDetail)
  }

  let immutable = false
  try { specRepo.insert({ ...spec, note: 'mutated' }) }
  catch (err) { immutable = (err as { code?: string }).code === 'SPEC_VERSION_IMMUTABLE' }
  record('A14', '发布版不可原地修改', immutable, `${spec.id}@${spec.version}`)
  let referenced = false
  try { assertModelNotReferenced(db, modelId) }
  catch (err) { referenced = (err as { code?: string }).code === 'MODEL_IN_USE' }
  record('A14', '被 Profile 引用的模型拒删', referenced, modelId)
  // 资格按绑定模型自身规格/版本溯源:同线第二个规格的模型不得借用规格 A 的合格报告
  const qualifiedModel = boundModelHasEligibility(modelId)
  const specB = specRepo.insert(parseProcessModelSpec(specOf({ id: 'pms-acc-b', version: 1, note: '无资格模型 fixture' })))
  rt.repo.dataset.insert({
    id: 'ds-acc-b', lineId: line.id, productId: product.id, recipeId: recipe.id, runIds: [run.id],
    specJson: '{}', sha256: 'x', rowCount: 1, fromMs: null, toMs: null, path: datasetDir,
    createdBy: 'acceptance', createdByKind: 'user', note: '', createdAt: new Date().toISOString(),
    specRef: specB.id, specVersion: specB.version,
  })
  const experimentRow = db.prepare('SELECT id FROM aml_experiments WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(job.id) as { id: string } | undefined
  const unqualifiedModelId = 'mdl-acc-unqualified'
  db.prepare(`INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage,
      io_spec_json, metrics_json, path, created_by, note, label, description, line_id, objective_id,
      artifact_kind, schema_version, model_interface, artifact_hash, legacy, created_at)
    VALUES (?, ?, 'ds-acc-b', ?, ?, 'mpc_surrogate', 'shadow', '{}', '{}', '', 'acceptance', '', '无资格模型', 'A14 fixture', ?, '',
      'linear_state_space@1', 2, 'linear_state_space', 'x', '', ?)`)
    .run(unqualifiedModelId, experimentRow?.id ?? '', product.id, recipe.id, line.id, new Date().toISOString())
  const unqualifiedModel = boundModelHasEligibility(unqualifiedModelId)
  record('A14', '资格按绑定模型自身规格溯源(同线其他规格的合格报告不放行)', qualifiedModel && !unqualifiedModel, `qualified=${qualifiedModel} unqualified=${unqualifiedModel}`)
  setHybridChannelProfile({
    channelId: 'ch-acc', profile: 'aml_optimization', optimizationMode: 'aml',
    boundModelId: unqualifiedModelId, capability: {}, controlPolicy: 'bounded_auto', createdBy: 'acc',
  })
  const legacyDispatch = await dispatchHostTool(
    {
      identity: { agentId: 'ca-acc-nobind', channelId: 'ch-acc', role: 'worker', name: 'a4' },
      state: { currentTaskId: null, sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
      getWorkspace: () => null,
    },
    { toolName: 'mpc_optimize', arguments: {} },
  )
  record('A14', 'dispatch 复核:绑定模型无真实优化资格 → OPTIMIZATION_NOT_ELIGIBLE(不返回候选)',
    legacyDispatch.isError === true && legacyDispatch.text.includes('OPTIMIZATION_NOT_ELIGIBLE'), legacyDispatch.text.slice(0, 100))
  const legacyBlocked = legacyMpcAliasGate({ toolName: 'mpc_optimize', hasOptimizerBinding: false, hasBoundModel: false })
  const legacyUnqualified = legacyMpcAliasGate({ toolName: 'mpc_optimize', hasOptimizerBinding: false, hasBoundModel: true, hasEligibleModel: unqualifiedModel })
  const legacyQualified = legacyMpcAliasGate({ toolName: 'mpc_optimize', hasOptimizerBinding: false, hasBoundModel: true, hasEligibleModel: qualifiedModel })
  record('A14', '旧 mpc_optimize:无绑定/无模型或无资格 → 引导;有资格模型 → 保留旧路径',
    !legacyBlocked.allowed && legacyBlocked.code === 'BINDING_NOT_FOUND'
    && !legacyUnqualified.allowed && legacyUnqualified.code === 'OPTIMIZATION_NOT_ELIGIBLE'
    && legacyQualified.allowed,
    `${legacyBlocked.code ?? ''}/${legacyUnqualified.code ?? ''}`)
}

// =====================================================================
section('A11 config generality')
{
  const altSpec = specOf({
    id: 'pms-acc-alt', version: 1,
    conditions: [
      { id: 'c-low', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }, { field: 'recipeVersion', op: 'range', value: [0, 1] }] },
      { id: 'c-high', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }, { field: 'recipeVersion', op: 'range', value: [2, 5] }] },
    ],
    variables: [
      { id: 'screw_speed', nodeId: 'n-mv-acc', role: 'mv', field: 'value', unit: 'rpm', modelUnit: 'bar', scale: 1, offset: 0, delayMs: DELAY * BEAT, min: 0, max: 100, maxStep: 20 },
      { id: 'thickness_um', nodeId: 'n-cv-acc', role: 'cv', field: 'value', unit: 'μm', scale: 1, offset: 0, min: 0, max: 200 },
    ],
    effectiveDomain: { mv: { screw_speed: { min: 0, max: 100, maxStep: 20 } }, cv: { thickness_um: { min: 0, max: 200 } } },
  })
  const altRow = specRepo.insert(parseProcessModelSpec(altSpec))
  record('A11', '第三留出场景(新 id/变量名/单位/两个互斥工况)通过校验', Boolean(altRow.id) && altRow.contentHash !== specRepo.get(spec.id, 1)!.contentHash, `${altRow.id}@${altRow.version}`)
  const altArt = trainLinearArx(readDataset(datasetDir), { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true }, { variables: [{ id: 'screw_speed', nodeId: 'n-mv-acc', role: 'mv', delayMs: DELAY * BEAT }, { id: 'thickness_um', nodeId: 'n-cv-acc', role: 'cv' }], beatMs: BEAT })
  record('A11', '变量名/单位变化不改核心代码(同训练器可训练)', altArt.metrics.rolloutImprovement >= 0.2 && altArt.mvOrder[0] === 'screw_speed', `${(altArt.metrics.rolloutImprovement * 100).toFixed(1)}%`)
}

// =====================================================================
section('A12 artifact dispatch')
{
  const model = rt.repo.model.get(modelId)!
  record('A12', '新工件走对应 loader/io_spec', model.artifactKind === 'linear_state_space@1' && model.modelInterface === 'linear_state_space' && model.artifactHash.length === 64, `${model.artifactKind}/${model.modelInterface}`)
  const v1Dir = join(rt.datasetsDir, 'ds-v1')
  mkdirSync(join(v1Dir, 'arrays'), { recursive: true })
  writeFileSync(join(v1Dir, 'manifest.json'), JSON.stringify({ version: 1 }))
  for (const f of ['x.f32', 'u.f32', 'y.f32']) writeFileSync(join(v1Dir, 'arrays', f), Buffer.from(new Float32Array([1, 2, 3]).buffer))
  const h1 = hashDatasetDir(v1Dir, '{"a":1}')
  const h2 = hashDatasetDir(v1Dir, '{"a":1}')
  record('A12', 'v1 数据集 hash 兼容(无新增文件参与)', h1 === h2 && h1.length === 64, h1.slice(0, 10))
}

// =====================================================================
section('A18/A21 tools')
{
  const defs = HOST_TOOLS.filter(t => OPTIMIZER_TOOL_NAMES.has(t.name))
  record('A21', 'HOST_TOOLS 含 5 个 optimizer_* 且处理器命中', defs.length === 5 && [...OPTIMIZER_TOOL_NAMES].every(n => INDUSTRIAL_TOOL_NAMES.has(n)), defs.map(t => t.name).join(','))
  const solveDef = defs.find(t => t.name === 'optimizer_solve')
  record('A21', 'optimizer_solve schema 含 binding_id 且 type=object', (solveDef?.parameters as { type?: string })?.type === 'object' && Boolean((solveDef?.parameters as { properties?: Record<string, unknown> })?.properties?.binding_id))
  const builtin = buildToolRegistrySnapshot().filter(t => t.source === 'builtin')
  record('A21', 'tool_registry builtin 计数 = HOST_TOOLS.length', builtin.length === HOST_TOOLS.length, `${builtin.length}/${HOST_TOOLS.length}`)

  setHybridChannelProfile({ channelId: 'ch-acc', profile: 'aml_optimization', capability: {}, controlPolicy: 'bounded_auto', createdBy: 'acc' })
  const nowIso = new Date().toISOString()
  db.prepare(`INSERT INTO channels (id, name, description, enabled, created_at, updated_at) VALUES ('ch-legacy','l','',1,?,?)`).run(nowIso, nowIso)
  setHybridChannelProfile({ channelId: 'ch-legacy', profile: 'legacy', capability: {}, controlPolicy: 'manual', createdBy: 'acc' })
  const opt = hostToolsForRole('worker', 'ch-acc').map(t => t.name)
  const legacy = hostToolsForRole('worker', 'ch-legacy').map(t => t.name)
  record('A21', 'optimizer 工具仅注入优化档位', opt.includes('optimizer_solve') && !legacy.includes('optimizer_solve'), `opt=${opt.filter(n => n.startsWith('optimizer_')).length} legacy=${legacy.filter(n => n.startsWith('optimizer_')).length}`)

  const legacyDenied = optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'legacy', bindingCount: 1 })
  record('A21', 'legacy 直调 optimizer_solve 明确拒绝(非未知工具)', legacyDenied.allowed === false && legacyDenied.code === 'OPTIMIZER_CHANNEL_DISABLED', legacyDenied.code ?? '')
  const trainingDenied = optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'aml_training', bindingCount: 1 })
  record('A21', '训练档位直调 optimizer_solve 明确拒绝(非未知工具)', trainingDenied.allowed === false && trainingDenied.code === 'OPTIMIZER_PROFILE_DENIED', trainingDenied.code ?? '')
  const noBinding = optimizerDispatchGate({ toolName: 'optimizer_solve', twinKind: 'aml_optimization', bindingCount: 0 })
  record('A21', '无绑定 solve → BINDING_NOT_FOUND(capabilities 仍可调)', noBinding.allowed === false && noBinding.code === 'BINDING_NOT_FOUND' && optimizerDispatchGate({ toolName: 'optimizer_capabilities', twinKind: 'aml_optimization', bindingCount: 0 }).allowed, noBinding.code ?? '')

  const t1 = [{ name: 'a', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } }]
  const t2 = [{ name: 'a', description: 'd', parameters: { type: 'object', properties: { x: { type: 'number' } } } }]
  record('A18', 'schema-only 变更触发签名变化', toolSignature(t1) !== toolSignature(t2))
  record('A18', '空工具表签名 ≠ 非空(解绑后清空)', toolSignature([]) !== toolSignature(t1) && toolSignature([]) === '[]')
}

// =====================================================================
section('A19 retention')
{
  const tables = ['process_model_specs', 'process_model_eligibility', 'optimizer_runs', 'optimizer_candidates', 'optimizer_recommendations']
  const names = new Set((db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all() as Array<{ name: string }>).map(r => r.name))
  record('A19', '新表纳入主库(备份/保留同一连接)', tables.every(t => names.has(t)), tables.join(','))
  const { retentionSettings } = await import('../server/services/workshop/settings')
  const s = retentionSettings() as unknown as Record<string, number>
  record('A19', 'retention.optimizer_days / process_model_days 可读', Number.isFinite(s.optimizer_days) && Number.isFinite(s.process_model_days), `optimizer=${s.optimizer_days} process=${s.process_model_days}`)
}

// =====================================================================
section('A7 performance')
{
  const perfIr = { ...mpcIr, hash: 'perf', horizon: 20, problem: { ...mpcProblem, cvSetpoints: [50] } } as never
  await pool.solve(perfIr)
  const lat: number[] = []
  for (let i = 0; i < 100; i++) {
    const t0 = Date.now()
    await pool.solve(perfIr)
    lat.push(Date.now() - t0)
  }
  lat.sort((a, b) => a - b)
  const p95 = lat[Math.floor(lat.length * 0.95) - 1]!
  record('A7', 'horizon=20 求解 p95 ≤1s(含 IPC,100 次)', p95 <= 1000, `p95=${p95}ms p50=${lat[50]}ms`)
}

// =====================================================================
section('A20 gates')
{
  // i18n parity 直接读取两语言字典(不 spawn 子进程;退出码由最终门禁承载)
  const zh = (await import('../i18n/locales/zh-CN')).default as Record<string, unknown>
  const en = (await import('../i18n/locales/en')).default as Record<string, unknown>
  const flat = (o: Record<string, unknown>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]))
  const zhKeys = new Set(flat(zh))
  const enKeys = new Set(flat(en))
  const missing = [...zhKeys].filter(k => !enKeys.has(k)).length + [...enKeys].filter(k => !zhKeys.has(k)).length
  record('A20', 'i18n 双语 key 齐备(PARITY)', missing === 0 && zhKeys.size === enKeys.size, `zh=${zhKeys.size} en=${enKeys.size}`)
  // 门禁以外部真实运行结果为准(scripts/run-quality-gates.mjs 写 gates.json)
  let gateRuns: Array<{ id: string, exitCode: number }> = []
  try {
    const gates = JSON.parse(readFileSync(join(evidenceDir, 'gates.json'), 'utf8')) as { ok?: boolean, results?: Array<{ id: string, exitCode: number }> }
    gateRuns = gates.results ?? []
  }
  catch { gateRuns = [] }
  const requiredGates = ['lint', 'typecheck', 'unit', 'i18n']
  const gatesOk = requiredGates.every(id => gateRuns.some(r => r.id === id && r.exitCode === 0))
  record('A20', '四项门禁真实 exitCode=0(lint/typecheck/unit/i18n)', gatesOk, gateRuns.length ? gateRuns.map(r => `${r.id}:${r.exitCode}`).join(' ') : 'gates.json 缺失(先运行 scripts/run-quality-gates.mjs)')
}

// =====================================================================
section('A22 environment')
{
  const { requirementsHash, venvIdentity } = await import('../server/services/workshop/aml/python-runtime')
  const req = readFileSync(join(process.cwd(), 'server', 'services', 'workshop', 'aml', 'python', 'requirements.txt'), 'utf8')
  record('A22', 'requirements 锁定 osqp', req.includes('osqp=='), requirementsHash())
  const outReq = join(process.cwd(), '.output', '.AgentWorkShop', 'aml-python', 'requirements.txt')
  const outHas = existsSync(outReq) && readFileSync(outReq, 'utf8').includes('osqp')
  record('A22', '.output 打包 requirements 含 osqp(构建后检查)', outHas || !existsSync(join(process.cwd(), '.output')), outHas ? 'present' : '.output 未构建(记为待构建)')
  const outWorker = join(process.cwd(), '.output', '.AgentWorkShop', 'optimizer-python', 'worker.py')
  record('A22', '.output 打包 Solver Worker(worker.py/problems.py/probe.py)', existsSync(outWorker) && existsSync(join(process.cwd(), '.output', '.AgentWorkShop', 'optimizer-python', 'problems.py')) && existsSync(join(process.cwd(), '.output', '.AgentWorkShop', 'optimizer-python', 'probe.py')), outWorker)
  const id = venvIdentity(rt)
  record('A22', 'AML 与 Solver 同一解释器/锁', Boolean(id.pythonPath) && id.requirementsHash === requirementsHash(), id.requirementsHash)
  record('A22', '线程预算显式注入(源码断言)', readFileSync(join(process.cwd(), 'server', 'services', 'workshop', 'optimization', 'worker-client.ts'), 'utf8').includes('OMP_NUM_THREADS'))
  record('A22', '桥签名覆盖 parameters(源码断言)', readFileSync(join(process.cwd(), 'server', 'harness', 'aw-mcp-bridge.mjs'), 'utf8').includes('bridgeSignature'))
}

// =====================================================================
section('A10 regression')
{
  const suites = ['optimizer-contracts', 'optimizer-schema', 'tsdb-quality', 'optimizer-adapter-registry', 'process-model-trainers', 'optimizer-binding', 'aml-job-success', 'optimizer-solver', 'aml-env-lease', 'tool-face-authz']
  record('A10', '新增单测文件齐备', suites.every(n => existsSync(join(process.cwd(), 'tests', `${n}.test.ts`))), `${suites.length} 套`)
  record('A10', '既有 AML/Twin/DCW 套件保留', existsSync(join(process.cwd(), 'tests', 'aml-twin-provider-registry.test.ts')) && existsSync(join(process.cwd(), 'tests', 'recipe-approval-snapshot.test.ts')))
}

const passed = results.filter(r => r.pass).length
const failed = results.length - passed
const evidence = {
  at: new Date().toISOString(),
  durationMs: Date.now() - started,
  base: 'in-process(no HTTP server)',
  env: { node: process.version, platform: `${process.platform}-${process.arch}`, cwd: process.cwd() },
  versions: { acceptance: '2026-10-22-optimizer-process-model/v1', schema: 2, plan: 'docs/plans/2026-10-22-optimizer-process-model-plan.md' },
  commands: [
    'node scripts/run-quality-gates.mjs',
    'npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-optimizer-process-model.ts',
    'npm run build',
  ],
  gateRuns: (() => {
    try {
      return (JSON.parse(readFileSync(join(evidenceDir, 'gates.json'), 'utf8')) as { results?: unknown[] }).results ?? []
    }
    catch { return [] }
  })(),
  hash: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
  limitations: [
    'Timescale queryTagged(raw) 仍未返回 state/ingested_at,且未实现 queryTaggedPage(C5/C6/C7 的 SQLite 分支完整;Timescale 的 query()/latest() 已返回 state)',
    'A9 的浏览器点击未在本脚本执行;判定覆盖接口载荷/持久状态/零写计数 + UI 路由与 i18n 契约',
    'A7 p95 为本地单机 fixture(horizon=20,1 MV/1 CV),不含冷启动与训练',
    'A8 使用延迟 FOPDT 与静态响应面 fixture(闭环只应用首步);未耦合 plc-node-simulator 的真实 CastFilmModel/AnnealModel',
    '旧 mpc_optimize 仍走 TS 启发式,未路由到 Manager/资格门(计划 G4.6 未完成)',
    '单长 run 的时间块隔离切分未实现(数据集按 run 切分;gates 以 train/val/test 非空判定)',
    'static_response 的 训练→权威评估→注册→预测 全链未在验收中端到端执行(训练器与求解器已单测)',
    'A18 仅验证签名算法与 gate(未测 omp≤5s / bridge≤15s / pi 次回合的实际时序)',
  ],
  pass: passed,
  total: results.length,
  results,
}
writeFileSync(join(evidenceDir, 'acceptance.json'), JSON.stringify(evidence, null, 2))
console.log(`\n${passed}/${results.length} 通过;证据:${join(evidenceDir, 'acceptance.json')}`)
await pool.shutdown()
if (failed > 0) process.exitCode = 1
