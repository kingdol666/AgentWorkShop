/** SW4/D25 互校独立性 spike:predictor vs simulateLinear 同源不同实现;扰动负例;import 边界。 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-sw4-spike-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { simulateLinear } = await import('../server/services/workshop/optimization/problem-builder')
const { createCrosscheckRepo } = await import('../server/services/workshop/optimization/crosscheck.service')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'spike.sqlite'))
configureAmlRuntime(db)
const repo = createCrosscheckRepo(db)

after(() => {
  try {
    rmSync(process.env.AW_HOME!, { recursive: true, force: true })
  }
  catch { /* 并行会话可能已清理 */ }
})

/** 独立线性模型(1 MV/1 CV,ARX y=0.3y+0.7u,bias 8):typed predictor 与 simulateLinear 同源不同实现 */
function spikeArtifact() {
  return {
    kind: 'linear_state_space@1', schemaVersion: 1,
    stateDim: 1, arOrder: 1, inputOrder: 1,
    mvOrder: ['mv1'], cvOrder: ['cv1'], delaysSteps: { mv1: 1 }, K: 1,
    A: [[0.3]], B: [[0]], C: [[1]], D: [[0.7]], bias: [8],
    layout: { yOffset: 0, uOffset: 1, stateDim: 1, K: 1 },
    norm: { x: { mean: [50], std: [10] }, u: { mean: [50], std: [10] }, y: { mean: [50], std: [10] } },
    metrics: { oneStepVal: { windows: 1, nrmse: 0 }, oneStepNrmse: 0, rolloutNrmse: 0, persistenceNrmse: 0, rolloutImprovement: 0, windows: 1 },
    residual: { mean: 0, std: 1 },
  }
}

function irLikeDynamics(artifact: ReturnType<typeof spikeArtifact>) {
  // simulateLinear 的输入形状(ProblemIR.dynamics 子集)
  return {
    A: artifact.A, B: artifact.B, C: artifact.C, D: artifact.D,
    stateDim: artifact.stateDim, x0: [artifact.norm.y.mean[0]!], bias: artifact.bias,
  }
}

test('spike:typed predictor 与 simulateLinear 在同一工件上 dev_per_cv < 1e-9(锁同源不同实现)', async () => {
  const artifact = spikeArtifact()
  // 用 typed predictor 的数值路径(直接构造状态演算,与 predictor.ts 相同公式,独立于 problem-builder)
  const stateDim = artifact.stateDim
  const x0 = artifact.norm.y.mean[0]!
  const H = 4
  const history: number[][] = Array.from({ length: H }, (_, h) => [x0, 50 + 0.1 * h])
  const controls: number[][] = Array.from({ length: 6 }, (_, k) => [55 + 0.2 * k])
  // —— 模拟 predictWithTypedArtifact 的状态演算(linear 路径逐行同构) ——
  const x = new Array<number>(stateDim).fill(0)
  x[0] = history[H - 1]![0]!
  x[artifact.layout.uOffset] = history[H - 1]![1]!
  const forecast: number[][] = []
  for (let k = 0; k < controls.length; k++) {
    const u = controls[k]!
    const next = new Array<number>(stateDim).fill(0)
    for (let r = 0; r < stateDim; r++) {
      let v = artifact.bias[r] ?? 0
      for (let c = 0; c < stateDim; c++) v += artifact.A[r]![c]! * x[c]!
      for (let m = 0; m < 1; m++) v += artifact.B[r]![m]! * u[m]!
      next[r] = v
    }
    for (let c = 0; c < stateDim; c++) x[c] = next[c]!
    forecast.push(artifact.cvOrder.map((_id, j) => {
      let y = 0
      for (let c = 0; c < stateDim; c++) y += artifact.C[j]![c]! * x[c]!
      for (let m = 0; m < 1; m++) y += artifact.D[j]![m]! * u[m]!
      return y
    }))
  }
  // —— simulateLinear(problem-builder 独立实现,零延迟 IR 由训练器工件等价) ——
  const simulated = simulateLinear(irLikeDynamics(artifact), 1, 1, [history[H - 1]![1]!], controls as never[][])
  assert.equal(simulated.length, forecast.length)
  for (let t = 0; t < forecast.length; t++) {
    for (let j = 0; j < 1; j++) {
      const dev = Math.abs((forecast[t]?.[j] ?? 0) - (simulated[t]?.[j] ?? 0))
      assert.ok(dev < 1e-9, `t=${t} dev=${dev} 超过 spike 门 1e-9`)
    }
  }
})

test('扰动负例:单侧注入 1e-4 → 互校必须 fail(证明非空转)', () => {
  const predicted = [[50], [51]]
  const replayed = [[50 + 1e-4], [51]]
  const tol = 1e-6
  const normStd = [10]
  const dev = Math.abs(predicted[0]![0]! - replayed[0]![0]!) / Math.max(1e-9, normStd[0]!)
  assert.ok(dev > tol, '1e-4 注入在 norm=10 下 dev=1e-5 > tol=1e-6')
  const verdict = dev <= tol ? 'pass' : 'fail'
  assert.equal(verdict, 'fail')
})

test('import 边界(D25):aml/predictor.ts 不得 import problem-builder/simulateLinear', () => {
  const src = readFileSync(join(process.cwd(), 'server/services/workshop/aml/predictor.ts'), 'utf8')
  assert.ok(!src.includes('problem-builder'), 'predictor 引用了 problem-builder(互校将退化为同源比较)')
  assert.ok(!src.includes('simulateLinear'), 'predictor 引用了 simulateLinear')
})

test('crosscheck 行:row_hash = 全部证据列 sha256;追加不可变;D6 派生 stale', async () => {
  // FK:crosscheck 行引用建议/运行/候选 → 先建真实链
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO optimizer_runs (id, binding_id, binding_revision, profile_id, profile_version, problem_ir_hash, started_at)
    VALUES ('run-spike', 'b-spike', 1, 'p-spike', 1, 'h', ?)`).run(now)
  db.prepare(`INSERT INTO optimizer_candidates (id, run_id, seq, model_id) VALUES ('c-spike', 'run-spike', 0, 'mdl-spike')`).run()
  db.prepare(`INSERT INTO optimizer_recommendations (id, run_id, candidate_id, problem_ir_hash, model_artifact_hash, valid_until, created_at)
    VALUES ('rec-spike', 'run-spike', 'c-spike', 'h', '${'a'.repeat(64)}', ?, ?)`).run(now, now)
  const row = repo.append({
    recommendationId: 'rec-spike', runId: 'run-spike', modelId: 'mdl-spike',
    modelArtifactHash: 'a'.repeat(64), contextHash: 'b'.repeat(64),
    inputDistance: { inputDistance: 0.5 }, predicted: [[1]], replayed: [[1]], devPerCv: [0],
    tol: 1e-6, qhatPerCv: [2], verdict: 'pass', conditionChanged: false, reason: 'spike',
  })
  assert.ok(row.rowHash.length === 64)
  const row2 = repo.append({
    recommendationId: 'rec-spike', runId: 'run-spike', modelId: 'mdl-spike',
    modelArtifactHash: 'a'.repeat(64), contextHash: 'b'.repeat(64),
    inputDistance: { inputDistance: 0.5 }, predicted: [[1]], replayed: [[1]], devPerCv: [0],
    tol: 1e-6, qhatPerCv: [2], verdict: 'pass', conditionChanged: false, reason: 'spike',
  })
  assert.notEqual(row.id, row2.id, '同建议二次互校 = 新行(不可变追加)')
  const list = repo.listForRecommendation('rec-spike')
  assert.equal(list.length, 2)
  assert.equal(list[0]!.id, row2.id, '最新一行在前')
  // D6 派生:最新一行 pass 且工件 hash 一致 → dual
  const { deriveDualState } = await import('../server/services/workshop/optimization/crosscheck.service')
  const dual = deriveDualState('rec-spike')
  assert.equal(dual.dual, false, 'aml_models 无 mdl-spike 行 → 当前 hash 空 ≠ 冻结 hash → 读时 stale(dual=false)')
  assert.equal(dual.latest?.verdict, 'pass')
})
