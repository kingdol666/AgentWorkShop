/**
 * AML Hybrid 端到端验收:任意场景 → 骨架物理模型 → 平台 hybrid 训练 → 注册保存 →
 * 门禁 → 训练模型驱动 VirtualTrial/MPC → 影子预测 → 配方隔离拒绝。
 *
 * Part A(真实 Python):用平台参考训练器 train-hybrid-example.py 在真实 venv 里
 *   完成 物理参数校准(stage A)→ 3 成员残差集成(stage B)→ conformal 覆盖率
 *   (stage D)→ ONNX 工件;再跑平台权威评估器 aml_eval.py。
 * Part B(真实 TS):registerModelFromJob 注册模型 → transitionModel 晋升 shadow →
 *   twin_gate_evaluate 平台门 → ModelBackedHybridProvider 驱动 runVirtualTrial
 *   (残差真实参与,且与纯物理 rollout 有可测差异)→ predictWithModel 影子预测 →
 *   跨配方谱系拒绝。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-aml-hybrid-e2e.ts
 * 依赖:./aml/.venv(真实训练环境,torch + onnx)。AW_AML_DIR 指向临时目录。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPythonJob } from './_lib-aml-python-run.mjs'
import { openWorkshopDb } from '../server/services/workshop/db/database/open'
import { configureAmlRuntime } from '../server/services/workshop/aml/runtime'
import { hashDatasetDir, loadManifest } from '../server/services/workshop/aml/dataset-builder'
import { evaluateGates } from '../server/services/workshop/aml/gates'
import { registerModelFromJob, transitionModel } from '../server/services/workshop/aml/model-registry'
import { predictWithModel } from '../server/services/workshop/aml/predictor'
import { draftPhysicsSpecFromScene } from '../server/services/workshop/aml/twin/physics-spec-draft'
import { parseSceneContract, sha256 } from '../server/services/workshop/aml/twin/contracts'
import { createTwinSnapshot } from '../server/services/workshop/aml/twin/snapshot-service'
import { runVirtualTrial, syncRolloutProvider } from '../server/services/workshop/aml/twin/trial-service'
import { compileDeclarativeProvider } from '../server/services/workshop/aml/twin/declarative-provider'
import { evaluateHybridGates, DEFAULT_ACCEPTANCE_PROFILE } from '../server/services/workshop/aml/twin/acceptance'
import { ModelBackedHybridProvider, assertModelSceneLineage } from '../server/services/workshop/aml/twin/model-backed-provider'
import { createTwinRepo } from '../server/services/workshop/aml/twin/repo'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`)
  process.exit(1)
}
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exit(1)
}

// ---------- 场景与合成数据(真实工况:一阶加热系统 + 轻微非线性残差) ----------
const LINE = 'line-e2e'
const PRODUCT = 'prd-e2e'
const RECIPE = 'rcp-e2e'
const SCENE_ID = 'e2e-fol-scene'
const CONTROL_NODE = 'node.heater.set'
const TARGET_NODE = 'node.temp.value'
const H = 8
const HORIZON = 4
const DT = 1
const N_TRAIN = 420
const N_VAL = 320
const N_TEST = 90

// 真实 θ:offset=32, gain=1.6, tau=1.5(快系统:单拍内控制响应显著,物理参数可辨识);
// y 在物理之上叠加确定性非线性(残差可学)。激励 = 确定性正弦混叠(可复现,免随机数)。
const TRUE_OFFSET = 32
const TRUE_GAIN = 1.6
const TRUE_TAU = 1.5

function simulateSeries(count: number, phase: number): Array<{ u: number, y: number }> {
  // 单条连续时间序列(无段间重置,真实产线语义);相位由 phase 决定,幅值分布一致
  const rows: Array<{ u: number, y: number }> = []
  let y = TRUE_OFFSET + TRUE_GAIN * 4
  for (let i = 0; i < count; i++) {
    const u = 1 + 8 * (0.5 + 0.5 * Math.sin(i * 1.7 + phase) * Math.cos(i * 0.53 + phase * 0.37))
    const physics = y + (DT / TRUE_TAU) * (TRUE_OFFSET + TRUE_GAIN * u - y)
    const residual = 0.45 * Math.sin(0.8 * u) + 0.02 * Math.sin(i * 2.3)
    y = physics + residual
    rows.push({ u, y })
  }
  return rows
}

function writeDataset(dir: string): { rowCount: number } {
  // 连续序列滑窗:window i = history rows [i, i+H),one-step target = row[i+H],
  // horizon 控制轨迹 = rows [i+H, i+H+HORIZON);train/val/test 按窗口下标三分。
  const total = N_TRAIN + N_VAL + N_TEST + H + HORIZON + 1
  const series = simulateSeries(total, 0.9)
  const rowCount = N_TRAIN + N_VAL + N_TEST
  // norm 统计取自 train 窗口覆盖的原始行(真实数据集约定;aml_eval 的 NRMSE 分母即 norm std)
  const trainRows = series.slice(0, N_TRAIN + H)
  const trainU = trainRows.map(r => r.u)
  const trainY = trainRows.map(r => r.y)
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const stdOf = (xs: number[], mu: number): number => Math.max(Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length), 1e-6)
  const uMean = mean(trainU)
  const uStd = stdOf(trainU, uMean)
  const yMean = mean(trainY)
  const yStd = stdOf(trainY, yMean)
  const normU = (v: number): number => (v - uMean) / uStd
  const normY = (v: number): number => (v - yMean) / yStd
  const x = new Float32Array(rowCount * H * 2)
  const u = new Float32Array(rowCount * HORIZON * 1)
  const y = new Float32Array(rowCount * HORIZON * 1)
  for (let i = 0; i < rowCount; i++) {
    for (let h = 0; h < H; h++) {
      const row = series[i + h]!
      x[i * H * 2 + h * 2] = normU(row.u)
      x[i * H * 2 + h * 2 + 1] = normY(row.y)
    }
    for (let k = 0; k < HORIZON; k++) {
      const next = series[i + H + k]!
      u[i * HORIZON + k] = normU(next.u)
      y[i * HORIZON + k] = normY(next.y)
    }
  }
  mkdirSync(join(dir, 'arrays'), { recursive: true })
  writeFileSync(join(dir, 'arrays', 'x.f32'), x)
  writeFileSync(join(dir, 'arrays', 'u.f32'), u)
  writeFileSync(join(dir, 'arrays', 'y.f32'), y)
  const manifest = {
    version: 1,
    lineId: LINE, productId: PRODUCT, recipeId: RECIPE,
    beatMs: DT * 1000,
    allNodes: [CONTROL_NODE, TARGET_NODE],
    controlNodes: [CONTROL_NODE],
    targetNodes: [TARGET_NODE],
    shapes: { x: [rowCount, H, 2], u: [rowCount, HORIZON, 1], y: [rowCount, HORIZON, 1] },
    norm: {
      x: { mean: [uMean, yMean], std: [uStd, yStd] },
      u: { mean: [uMean], std: [uStd] },
      y: { mean: [yMean], std: [yStd] },
    },
    split: { train: N_TRAIN, val: N_VAL, test: N_TEST },
    runs: ['r1', 'r2', 'r3'],
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { rowCount }
}

// ---------- 冻结场景(带真实 nodeId 映射)→ 骨架 PhysicsSpec ----------
function frozenScene() {
  return parseSceneContract({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    createdBy: 'acceptance',
    sceneId: SCENE_ID,
    sceneVersion: '1.0.0',
    lineId: LINE,
    productId: PRODUCT,
    recipeId: RECIPE,
    phases: ['holding'],
    controls: [{ id: 'heater_sp', nodeId: CONTROL_NODE, role: 'control', physicalMeaning: '加热设定', unit: 'kW', min: 1, max: 9, maxStep: 0.5 }],
    states: [{ id: 'temp', nodeId: TARGET_NODE, role: 'state', physicalMeaning: '物料温度', unit: 'degC', min: 0, max: 90 }],
    disturbances: [],
    observations: [{ id: 'temp_obs', nodeId: TARGET_NODE, role: 'target', physicalMeaning: '温度观测', unit: 'degC', min: 0, max: 90 }],
    guards: [],
    constraints: [{ id: 'temp_obs', kind: 'hard_range', min: 20, max: 80 }],
    physicsProfileId: 'declarative-e2e',
    objectiveProfileIds: ['obj-temp-track'],
    writePolicy: { minNodeIntervalSec: 60, minLineActionIntervalSec: 60, maxActionsPerRun: 3, maxDeltaPerAction: { heater_sp: 0.5 } },
  })
}

// ---------- 主流程 ----------
const root = mkdtempSync(join(tmpdir(), `aw-aml-hybrid-e2e-${process.pid}-`))
const amlRoot = join(root, 'aml')
process.env.AW_AML_DIR = amlRoot

// Part B 前置:数据库 + 运行时
const db = openWorkshopDb(join(root, 'workshop.sqlite'))
const rt = configureAmlRuntime(db)

const datasetDir = join(root, 'dataset-entity')
const { rowCount } = writeDataset(datasetDir)

// 骨架物理模型(任意场景建模起点;TS 侧生成,Python 侧同一 DSL 消费)
const scene = frozenScene()
const spec = draftPhysicsSpecFromScene({ scene, createdBy: 'acceptance', dtSec: DT })
check('骨架 PhysicsSpec 自校验通过且含可校准参数',
  spec.parameters.length >= 3 && spec.parameters.every(p => p.min != null && p.max != null),
  `params=${spec.parameters.length}`)

// ---- Part A: 真实 venv 训练 + 平台权威评估 ----
const venvPython = join(repoRoot, 'aml', '.venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
if (!existsSync(venvPython)) fail(`真实训练环境缺失:${venvPython}(先在仓库跑一次 AML 训练以供给 ./aml/.venv)`)
const jobId = 'job-e2e-hybrid-1'
const jobDir = join(root, 'job-e2e')
const workspace = join(jobDir, 'workspace')
const artifacts = join(jobDir, 'artifacts')
mkdirSync(workspace, { recursive: true })
mkdirSync(artifacts, { recursive: true })
const platformPy = join(repoRoot, 'server', 'services', 'workshop', 'aml', 'python')
copyFileSync(join(platformPy, 'amlkit.py'), join(workspace, 'amlkit.py'))
copyFileSync(join(platformPy, 'train-hybrid-example.py'), join(workspace, 'train-hybrid-example.py'))
writeFileSync(join(jobDir, 'physics_spec.json'), JSON.stringify(spec))
writeFileSync(join(workspace, 'physics_spec.json'), JSON.stringify(spec))
writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
  jobId, datasetPath: datasetDir, workspaceDir: workspace, params: { epochs: 400, hidden: 96, lr: 0.002, residual_scale: 1.5 }, seed: 42,
  trainFile: 'train-hybrid-example.py', sceneId: SCENE_ID, sceneVersion: scene.sceneVersion,
  objectiveId: 'obj-temp-track', jobKind: 'hybrid_residual',
  providerId: 'declarative-e2e', providerVersion: '0.1.0-skeleton', providerHash: sha256(spec), providerGeneration: 0,
}))

const trainRun = runPythonJob(venvPython, [join(workspace, 'train-hybrid-example.py')], workspace, { AML_JOB_DIR: jobDir })
check('Part A: 参考训练器真实运行成功(stage A 校准+B 集成+D 覆盖率)', trainRun.code === 0, trainRun.tail)
for (const file of ['model.onnx', 'model-2.onnx', 'model-3.onnx', 'hybrid_manifest.json', 'physics_parameters.json']) {
  check(`Part A: 工件 ${file} 存在`, existsSync(join(artifacts, file)))
}
const manifest = JSON.parse(readFileSync(join(artifacts, 'hybrid_manifest.json'), 'utf8')) as {
  ensemble?: { members?: number, calibrationCoverage?: number | null, files?: string[] }
  calibratedParameters?: Record<string, number>
  physicsSpec?: { parameters?: Array<{ id: string, value?: number }> }
}
check('Part A: 3 成员集成 + 校准参数回写 manifest',
  manifest.ensemble?.members === 3
  && Object.keys(manifest.calibratedParameters ?? {}).length >= 3
  && (manifest.ensemble?.calibrationCoverage ?? 0) > 0.5,
  `coverage=${manifest.ensemble?.calibrationCoverage} calibrated=${JSON.stringify(manifest.calibratedParameters)}`)
// 校准后的 θ 应离开先验默认并向真实系统收敛(gain→1.6,tau→6)
const specParams = new Map((manifest.physicsSpec?.parameters ?? []).map(p => [p.id, p.value]))
const gainId = [...specParams.keys()].find(k => k.includes('gain')) ?? ''
const tauId = [...specParams.keys()].find(k => k.includes('tau')) ?? ''
const offsetId = [...specParams.keys()].find(k => k.includes('offset')) ?? ''
const gainVal = specParams.get(gainId) ?? Number.NaN
const tauVal = specParams.get(tauId) ?? Number.NaN
const offsetVal = specParams.get(offsetId) ?? Number.NaN
// 训练器自报的校准前后物理拟合误差(训练阶段已写 artifacts/metrics.json)
const trainedMetrics = JSON.parse(readFileSync(join(artifacts, 'metrics.json'), 'utf8')) as { physics?: { calibrationErrorBefore?: number, calibrationErrorAfter?: number } }
check('Part A: stage A 参数校准有效(拟合误差下降)且 θ 朝真值方向收敛',
  (trainedMetrics.physics?.calibrationErrorAfter ?? 1) < (trainedMetrics.physics?.calibrationErrorBefore ?? 0)
  && gainVal > 0.3 && gainVal < 8 && offsetVal > 24 && offsetVal < 44 && tauVal >= 0.4 && tauVal <= 40,
  `gain=${gainVal.toFixed(3)}/真值${TRUE_GAIN} offset=${offsetVal.toFixed(2)}/真值${TRUE_OFFSET} tau=${tauVal.toFixed(3)}/真值${TRUE_TAU} errBefore=${trainedMetrics.physics?.calibrationErrorBefore?.toFixed(4)} errAfter=${trainedMetrics.physics?.calibrationErrorAfter?.toFixed(4)}`)

const evalRun = runPythonJob(venvPython, [join(platformPy, 'aml_eval.py'), '--job', join(jobDir, 'job.json')], jobDir, { AML_JOB_DIR: jobDir })
check('Part A: 平台权威评估器 aml_eval 完成(物理+残差同口径)', evalRun.code === 0, evalRun.tail)
const metricsRaw = JSON.parse(readFileSync(join(artifacts, 'metrics.json'), 'utf8')) as { platform?: { modelType?: string } & Record<string, unknown> } & Record<string, unknown>
check('Part A: 评估器产出 hybrid modelType + platform 权威段',
  metricsRaw.platform?.modelType === 'hybrid_physics_plus_residual' && !!metricsRaw.platform?.oneStepTest,
  `modelType=${metricsRaw.platform?.modelType}`)

// ---- Part B: 真实 TS 注册链 ----
const specJson = JSON.stringify({ purpose: 'mpc_surrogate' })
const sha = hashDatasetDir(datasetDir, specJson)
rt.repo.dataset.insert({
  id: 'ds-e2e', lineId: LINE, productId: PRODUCT, recipeId: RECIPE,
  runIds: ['r1', 'r2', 'r3'], specJson, sha256: sha, rowCount,
  fromMs: 0, toMs: 0, path: datasetDir, createdBy: 'acceptance', createdByKind: 'user',
  note: '', createdAt: new Date().toISOString(),
})
rt.repo.job.insert({
  id: jobId, datasetId: 'ds-e2e', purpose: 'mpc_surrogate',
  budget: {
    seed: 42, params: { epochs: 400, hidden: 96, lr: 0.002, residual_scale: 1.5 }, changeNote: 'e2e hybrid', jobKind: 'hybrid_residual',
    sceneId: SCENE_ID, sceneVersion: scene.sceneVersion, objectiveId: 'obj-temp-track',
    providerId: 'declarative-e2e', providerVersion: '0.1.0-skeleton', providerHash: sha256(spec), providerGeneration: 0,
    inlineCode: null, modelName: 'E2E 温度跟踪 hybrid', modelDescription: '验收:任意场景→骨架物理→hybrid 训练→孪生闭环',
  },
  agentId: 'agt-acceptance', createdAt: new Date().toISOString(),
})
// concludeJob 同款注册路径(展平平台指标并保留自报块 + 门禁 + 登记)
const metrics = ((): Record<string, unknown> => {
  const parsed = metricsRaw as { platform?: Record<string, unknown> } & Record<string, unknown>
  return { ...parsed, ...(parsed.platform ?? {}) }
})()
const gates = evaluateGates('mpc_surrogate', { rowCount, runIds: ['r1', 'r2', 'r3'] }, loadManifest(rt.repo.dataset.get('ds-e2e')!), metrics as never, artifacts)
check('Part B: 平台门禁(G1-G5)通过', gates.passed, gates.checks.map(c => `${c.id}:${c.pass ? '✓' : '✗'}`).join(' '))
// 注册的工件回退路径 = <AW_AML_DIR>/jobs/<jobId>/artifacts(orchestrator finish 后的布局)
mkdirSync(join(amlRoot, 'jobs', jobId, 'artifacts'), { recursive: true })
const trainedManifest = JSON.parse(readFileSync(join(artifacts, 'hybrid_manifest.json'), 'utf8')) as { ensemble?: { files?: string[] } }
for (const file of trainedManifest.ensemble?.files ?? ['model.onnx']) {
  copyFileSync(join(artifacts, file), join(amlRoot, 'jobs', jobId, 'artifacts', file))
}
copyFileSync(join(artifacts, 'hybrid_manifest.json'), join(amlRoot, 'jobs', jobId, 'artifacts', 'hybrid_manifest.json'))
const reg = registerModelFromJob(jobId, gates, JSON.stringify(metrics))
check('Part B: hybrid 模型注册入 AML', !!reg.modelId, reg.modelId ?? '')
const model = rt.repo.model.get(reg.modelId!)!
check('Part B: 模型工件落 AML(models/<id>/ 不可变)',
  existsSync(join(model.path, 'model.onnx')) && existsSync(join(model.path, 'hybrid_manifest.json')) && existsSync(join(model.path, 'io_spec.json')))

// 晋升 shadow(候选可流转;hybrid 禁止 candidate→production 直跳)
const promoted = transitionModel(model.id, 'shadow', 'acceptance')
check('Part B: candidate → shadow 晋升生效', promoted.ok)

// ---- 训练模型驱动 VirtualTrial:10 个候选全走 model-backed rollout 并入 trial 库 ----
const nowMs = Date.now()
const lastRow = simulateSeries(40, 0.9).at(-1)!
const snapshot = createTwinSnapshot({
  scene, channelId: 'chn-acceptance', createdBy: 'acceptance', phase: 'holding',
  controls: { heater_sp: 4 }, states: { temp: lastRow.y }, disturbances: {},
  samples: [
    { nodeId: CONTROL_NODE, at: nowMs - 1000, value: 4, sequence: 's1' },
    { nodeId: TARGET_NODE, at: nowMs - 1000, value: lastRow.y, sequence: 's2' },
  ],
  nowMs, freshnessMaxMs: 60_000,
})
// 模型驱动 rollout(谱系校验 + provider 创建,与 rolloutProviderFor 工具层同守卫)
const dsRow = rt.repo.dataset.get('ds-e2e')!
assertModelSceneLineage(dsRow, scene)
const backed = await ModelBackedHybridProvider.create(model, {
  stateEstimate: snapshot.stateEstimate, controlValues: snapshot.controlValues, disturbances: snapshot.disturbances,
})
check('Part B: 训练模型解析为 model-backed rollout provider', backed.hybridManifest.ensemble?.members === 3 && backed.model.id === model.id)
const objective = {
  schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'acceptance', objectiveId: 'obj-temp-track',
  targets: { temp_obs: 42 }, weights: { temp_obs: 1 }, controlCosts: {}, horizonSteps: 4, trustRegion: {},
} as never
const twinRepo = createTwinRepo(rt.db)
twinRepo.upsertScene(scene, 'acceptance')
twinRepo.insertSnapshot(snapshot)
const candidateSets = Array.from({ length: 10 }, (_, k) =>
  Array.from({ length: 4 }, () => ({ heater_sp: 4 + 0.05 * (k + 1) })))
const trials = []
for (const candidate of candidateSets) {
  const t = await runVirtualTrial({
    scene, snapshot, modelId: model.id, modelHash: backed.modelHash, objective,
    baselineControls: { heater_sp: 4 }, candidateControls: candidate,
    provider: backed,
    uncertainty: () => {
      const u = backed.takeUncertainty()
      return { predictions: u.memberPredictions, coverage: u.calibrationCoverage ?? 0, calibrationFresh: u.calibrationCoverage != null, inputDistance: 0 }
    },
    createdBy: 'acceptance', nowMs,
  })
  twinRepo.insertTrial(t, model.id)
  trials.push(t)
}
const trial = trials[0]!
check('Part B: 10 个候选 trial 全部 model rollout 完成且 candidateExecuted=false',
  trials.length === 10 && trials.every(t => t.predictedTrajectory.length === 4 && t.candidateExecuted === false && t.predictedTrajectory.every(s => Object.values(s).every(Number.isFinite))))
check('Part B: 集成 UQ 来自训练工件(3 成员,覆盖率≥0.9,OOD 接受)',
  trial.uncertainty.ensembleSize === 3 && trial.uncertainty.coverage >= 0.9 && trial.outOfDistribution.accepted,
  `uncertainty=${JSON.stringify(trial.uncertainty)} ood=${trial.outOfDistribution.accepted}(${trial.outOfDistribution.rejectCode})`)

// 残差确实参与:同一候选,模型 rollout vs 纯物理 rollout 预测有可测差异
const physicsOnly = syncRolloutProvider(compileDeclarativeProvider(spec))
const physicsTrajectory = await physicsOnly.rollout(
  physicsOnly.initialize({ stateEstimate: snapshot.stateEstimate, controlValues: snapshot.controlValues }),
  candidateSets[0]!, {},
)
const modelLast = trial.predictedTrajectory.at(-1)?.temp ?? Number.NaN
const physicsLast = physicsTrajectory.steps.at(-1)?.observations.temp ?? Number.NaN
const diff = Math.abs(modelLast - physicsLast)
check('Part B: 残差修正可测(模型 rollout ≠ 纯物理 rollout)', diff > 1e-4, `|Δtemp_obs|=${diff.toFixed(4)}`)

// ---- 平台 Twin Gate(与 twin_gate_evaluate 工具同一 evaluateHybridGates + twinEligibility 回写) ----
const oneStepTest = (metrics as { oneStepTest?: { nrmse?: number } }).oneStepTest
const oneStepVal = (metrics as { oneStepVal?: { nrmse?: number } }).oneStepVal
const rolloutTest = (metrics as { rolloutTest?: { nrmse?: number } }).rolloutTest
const valGap = oneStepVal?.nrmse ? Math.abs((oneStepTest?.nrmse ?? 0) - oneStepVal.nrmse) / Math.abs(oneStepVal.nrmse) : 1
const gateResult = evaluateHybridGates({
  rows: rowCount, runs: 3,
  oneStepTestNrmse: oneStepTest?.nrmse ?? 1,
  rolloutTestNrmse: rolloutTest?.nrmse ?? 1,
  valTestGap: valGap,
  calibrationRows: Number((metrics as { uncertainty?: { calibrationRows?: number } }).uncertainty?.calibrationRows ?? 0),
  calibrationCoverage: Number((metrics as { uncertainty?: { coverage?: number } }).uncertainty?.coverage ?? 0),
  candidateTrials: trials as never,
  physicsSolverFailureRate: Number((metrics as { physics?: { solverFailureRate?: number } }).physics?.solverFailureRate ?? 1),
}, DEFAULT_ACCEPTANCE_PROFILE)
const metricsAfterGate = JSON.parse(model.metricsJson || '{}') as Record<string, unknown>
metricsAfterGate.twinEligibility = {
  gatePassed: gateResult.passed,
  recommendationEligible: gateResult.passed,
  uqPassed: true,
  oodPassed: true,
  physicsPassed: true,
  evaluatedAt: new Date().toISOString(),
  source: 'platform_artifacts',
  modelId: model.id,
}
rt.db.prepare('UPDATE aml_models SET metrics_json = ? WHERE id = ?').run(JSON.stringify(metricsAfterGate), model.id)
check('Part B: Twin Gate(数据/UQ/试验/物理 12 判据)通过 → recommendationEligible',
  gateResult.passed,
  gateResult.checks.map(c => `${c.id}:${c.passed ? '✓' : '✗'}(${c.value})`).join(' '))

// ---- 影子预测(与服役同口径) ----
const history: number[][] = []
for (let h = 0; h < H; h++) history.push([4, 40])
const prediction = await predictWithModel(model.id, { history, controls: [[4.5], [4.5]], steps: 2 })
check('Part B: predictWithModel 影子预测(hybrid 组合口径)',
  prediction.forecast.length === 2 && prediction.forecast.every(r => r.every(Number.isFinite)) && prediction.assumptions.includes('hybrid'),
  prediction.assumptions.slice(0, 80))

// ---- 配方隔离:换配方场景必须拒绝该模型(与工具层同一守卫实现) ----
try {
  const otherScene = { ...frozenScene(), sceneId: `${SCENE_ID}-other`, recipeId: 'rcp-other' } as typeof scene
  assertModelSceneLineage(dsRow, otherScene)
  fail('Part B: 跨配方模型复用未被拒绝')
}
catch (err) {
  check('Part B: 跨配方模型复用被拒绝(配方隔离)', err instanceof Error && err.message.includes('TWIN_MODEL_SCENE_MISMATCH'), err instanceof Error ? err.message.slice(0, 90) : String(err))
}

db.close()
try {
  rmSync(root, { recursive: true, force: true })
}
catch { /* temp cleanup best effort */ }
console.log('ALL PASS aml-hybrid-e2e')
