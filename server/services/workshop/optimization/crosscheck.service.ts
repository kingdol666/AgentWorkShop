/**
 * 候选互校服务(SW4/D1/D6/D7/D8/D25):
 * 同一模型工件的两个独立实现 —— Solver 输出的 candidate.predicted vs AML typed predictor replay ——
 * 做逐 CV 无量纲数值一致性比对。互校结果是计算态(不改建议 status),追加不可变行。
 *
 * 锚定与防污染:
 *  - D7 输入一律取 optimizer_runs.context_snapshot_json(模型单位,冻结快照),按 io_spec allNodes 重排列序;
 *  - D8 互校前强制 aml_models.artifact_hash == rec.model_artifact_hash(模型被替换 → 409,不产出行);
 *  - D25 运行期比较对钉死(worker candidate.predicted vs aml/predictor typed replay;predictor 不得 import problem-builder);
 *  - D6 dual 态 = 最新一行(created_at DESC,id DESC)verdict='pass' 且读时 stale=false;最新行 fail 即无 dual,禁止回溯。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { optimizerCrosscheckTol } from '../settings'
import { getAmlRuntime } from '../aml/runtime'
import { predictWithModel, resolveArtifactKind } from '../aml/predictor'
import { getRunRepo } from './run.repo'

export interface CrosscheckRow {
  id: string
  recommendationId: string
  runId: string
  modelId: string
  modelArtifactHash: string
  contextHash: string
  inputDistanceSnapshot: Record<string, unknown>
  devPerCv: number[]
  tol: number
  maxDevDimensionless: number | null
  verdict: 'pass' | 'fail' | 'not_applicable'
  conditionChanged: boolean
  stale: boolean
  reason: string
  rowHash: string
  createdAt: string
}

const CROSSCHECK_COLS = `id, recommendation_id AS recommendationId, run_id AS runId, model_id AS modelId,
  model_artifact_hash AS modelArtifactHash, context_hash AS contextHash,
  input_distance_snapshot_json AS inputDistanceJson, dev_per_cv_json AS devPerCvJson,
  tol, max_dev_dimensionless AS maxDevDimensionless, qhat_per_cv_json AS qhatPerCvJson,
  verdict, condition_changed AS conditionChangedNum, stale, reason, row_hash AS rowHash, created_at AS createdAt`

function rowToCrosscheck(r: Record<string, unknown>): CrosscheckRow {
  return {
    id: String(r.id), recommendationId: String(r.recommendationId), runId: String(r.runId),
    modelId: String(r.modelId), modelArtifactHash: String(r.modelArtifactHash), contextHash: String(r.contextHash),
    inputDistanceSnapshot: JSON.parse(String(r.inputDistanceJson || '{}')) as Record<string, unknown>,
    devPerCv: JSON.parse(String(r.devPerCvJson || '[]')) as number[],
    tol: Number(r.tol), maxDevDimensionless: r.maxDevDimensionless == null ? null : Number(r.maxDevDimensionless),
    verdict: String(r.verdict) as CrosscheckRow['verdict'],
    conditionChanged: Number(r.conditionChangedNum) === 1,
    stale: Number(r.stale) === 1,
    reason: String(r.reason ?? ''), rowHash: String(r.rowHash ?? ''), createdAt: String(r.createdAt),
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 互校锚模型:候选行 model_id 优先(新列);旧行回退 run.profile → profile.modelRef */
function resolveModelId(rt: ReturnType<typeof getAmlRuntime>, rec: { candidateId: string }, run: { profileId: string, profileVersion: number }): string {
  const direct = String((rt.db.prepare('SELECT model_id AS m FROM optimizer_candidates WHERE id = ?').get(rec.candidateId) as { m?: string } | undefined)?.m ?? '')
  if (direct) return direct
  const profileRow = rt.db.prepare('SELECT model_ref AS modelRef FROM optimizer_profiles WHERE id = ? AND version = ?')
    .get(run.profileId, run.profileVersion) as { modelRef?: string } | undefined
  try {
    const ref = JSON.parse(profileRow?.modelRef || '{}') as { modelId?: string }
    return ref.modelId ?? ''
  }
  catch {
    return ''
  }
}

/** D6 stale 读时谓词:工件被换/查不到(不可确认 = fail-closed)/绑定 revision 变化 → 旧行失效 */
function deriveStale(row: Record<string, unknown>, currentArtifactHash: string, currentRevision: number): boolean {
  const rowHash = String(row.modelArtifactHash ?? row.model_artifact_hash ?? '')
  if (currentArtifactHash === '' || rowHash === '') return true
  return Number(row.stale) === 1
    || rowHash !== currentArtifactHash
    || Number(row.binding_revision ?? row.bindingRevision ?? -1) !== currentRevision
}

export function createCrosscheckRepo(db: ReturnType<typeof getAmlRuntime>['db']) {
  const insert = db.prepare(`INSERT INTO optimizer_candidate_crosschecks
    (id, recommendation_id, run_id, model_id, model_artifact_hash, context_hash,
     input_distance_snapshot_json, predicted_json, replayed_json, dev_per_cv_json,
     tol, max_dev_dimensionless, qhat_per_cv_json, verdict, condition_changed, stale, reason, row_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  return {
    append(input: {
      recommendationId: string
      runId: string
      modelId: string
      modelArtifactHash: string
      contextHash: string
      inputDistance: Record<string, unknown>
      predicted: unknown[]
      replayed: unknown[][]
      devPerCv: number[]
      tol: number
      qhatPerCv: number[]
      verdict: CrosscheckRow['verdict']
      conditionChanged: boolean
      reason: string
    }): CrosscheckRow {
      const id = `oxc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const now = new Date().toISOString()
      const maxDev = input.devPerCv.length ? Math.max(...input.devPerCv) : null
      const rowHash = sha256(JSON.stringify([
        input.recommendationId, input.runId, input.modelId, input.modelArtifactHash, input.contextHash,
        input.inputDistance, input.predicted, input.replayed, input.devPerCv, input.tol,
        input.qhatPerCv, input.verdict, input.conditionChanged ? 1 : 0,
      ]))
      insert.run(
        id, input.recommendationId, input.runId, input.modelId, input.modelArtifactHash, input.contextHash,
        JSON.stringify(input.inputDistance), JSON.stringify(input.predicted), JSON.stringify(input.replayed),
        JSON.stringify(input.devPerCv.map(d => Number(d.toFixed(12)))),
        input.tol, maxDev, JSON.stringify(input.qhatPerCv), input.verdict,
        input.conditionChanged ? 1 : 0, 0, input.reason, rowHash, now,
      )
      return {
        id, recommendationId: input.recommendationId, runId: input.runId, modelId: input.modelId,
        modelArtifactHash: input.modelArtifactHash, contextHash: input.contextHash,
        inputDistanceSnapshot: input.inputDistance, devPerCv: input.devPerCv, tol: input.tol,
        maxDevDimensionless: maxDev, verdict: input.verdict, conditionChanged: input.conditionChanged,
        stale: false, reason: input.reason, rowHash, createdAt: now,
      }
    },
    /** 最新一行(D6:不按 verdict 过滤;fail 即无 dual);附当前工件 hash/绑定 revision 供 stale 派生 */
    latestForRecommendation(recommendationId: string): { row: Record<string, unknown> | null, currentArtifactHash: string, currentRevision: number } {
      const rec = getRunRepo().getRecommendation(recommendationId)
      const run = rec ? getRunRepo().getRun(rec.runId) : undefined
      const modelId = rec && run ? resolveModelId(getAmlRuntime(), rec, run) : ''
      const modelHash = modelId
        ? String((db.prepare('SELECT artifact_hash AS h FROM aml_models WHERE id = ?').get(modelId) as { h?: string } | undefined)?.h ?? '')
        : ''
      const revision = run?.bindingRevision ?? -1
      const row = db.prepare(`SELECT ${CROSSCHECK_COLS}, (SELECT binding_revision FROM optimizer_runs WHERE id = optimizer_candidate_crosschecks.run_id) AS binding_revision
        FROM optimizer_candidate_crosschecks WHERE recommendation_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(recommendationId) as Record<string, unknown> | undefined
      return { row: row ?? null, currentArtifactHash: modelHash, currentRevision: revision }
    },
    listForRecommendation(recommendationId: string, limit = 20): CrosscheckRow[] {
      return (db.prepare(`SELECT ${CROSSCHECK_COLS} FROM optimizer_candidate_crosschecks WHERE recommendation_id = ?
        ORDER BY rowid DESC LIMIT ?`).all(recommendationId, limit) as unknown as Record<string, unknown>[]).map(rowToCrosscheck)
    },
  }
}

type CrosscheckRepo = ReturnType<typeof createCrosscheckRepo>

const g = globalThis as typeof globalThis & { __optimizerCrosscheckRepo?: CrosscheckRepo }

export function getCrosscheckRepo(): CrosscheckRepo {
  g.__optimizerCrosscheckRepo ??= createCrosscheckRepo(getAmlRuntime().db)
  return g.__optimizerCrosscheckRepo
}

/** D6/D11 派生读:最新一行 pass 且读时 stale=false 才算「互校一致」;fail/not_applicable/无行 → 无 dual */
export function deriveDualState(recommendationId: string): {
  dual: boolean
  latest: {
    id: string
    verdict: string
    stale: boolean
    conditionChanged: boolean
    maxDev: number | null
    tol: number
    rowHash: string
    createdAt: string
  } | null
} {
  const { row, currentArtifactHash, currentRevision } = getCrosscheckRepo().latestForRecommendation(recommendationId)
  if (!row) return { dual: false, latest: null }
  const stale = deriveStale(row, currentArtifactHash, currentRevision)
  const parsed = rowToCrosscheck(row)
  return {
    dual: parsed.verdict === 'pass' && !stale,
    latest: {
      id: parsed.id, verdict: parsed.verdict, stale,
      conditionChanged: parsed.conditionChanged,
      maxDev: parsed.maxDevDimensionless, tol: parsed.tol,
      rowHash: parsed.rowHash, createdAt: parsed.createdAt,
    },
  }
}

/** 互校主流程:冻结快照回放 + 逐 CV 无量纲一致性(D1/D7/D8) */
export async function runCrosscheck(recommendationId: string): Promise<CrosscheckRow> {
  const rt = getAmlRuntime()
  const rec = getRunRepo().getRecommendation(recommendationId)
  if (!rec) throw new AppError(404, 'RECOMMENDATION_NOT_FOUND', `建议 ${recommendationId} 不存在`)
  const run = getRunRepo().getRun(rec.runId)
  if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `建议所属运行 ${rec.runId} 不存在`)
  const modelId = resolveModelId(rt, rec, run)
  if (!modelId) throw new AppError(404, 'MODEL_NOT_FOUND', '候选/运行均未记录求解模型;无法互校')
  const modelRow = rt.repo.model.get(modelId)
  if (!modelRow) throw new AppError(404, 'MODEL_NOT_FOUND', `模型 ${modelId} 不存在`)

  // D8 防污染:工件被替换 → 拒绝给旧建议盖章
  if ((modelRow.artifactHash || '') !== rec.modelArtifactHash) {
    throw new AppError(409, 'CROSSCHECK_MODEL_REPLACED',
      `模型工件已替换(现在 ${String(modelRow.artifactHash || '').slice(0, 12)},建议冻结 ${rec.modelArtifactHash.slice(0, 12)});请重新 solve 后再互校`)
  }

  const kind = resolveArtifactKind(modelRow)
  if (kind !== 'linear_state_space@1' && kind !== 'static_response@1') {
    // 旧 ONNX 工件:typed predictor 无独立 replay → not_applicable(禁下发由 dispatch 门保证)
    return getCrosscheckRepo().append({
      recommendationId, runId: rec.runId, modelId, modelArtifactHash: rec.modelArtifactHash,
      contextHash: '', inputDistance: {}, predicted: [], replayed: [], devPerCv: [],
      tol: optimizerCrosscheckTol(), qhatPerCv: [], verdict: 'not_applicable',
      conditionChanged: false, reason: `工件类型 ${kind} 无 typed 独立 replay;互校不适用`,
    })
  }

  // D7 冻结快照回放(context_snapshot_json 未在 RUN_COLS 映射,直查列)
  const snapshotJson = String((rt.db.prepare('SELECT context_snapshot_json AS s FROM optimizer_runs WHERE id = ?').get(rec.runId) as { s?: string } | undefined)?.s ?? '{}')
  const context = JSON.parse(snapshotJson) as {
    history?: number[][]
    variables?: Array<{ id: string, nodeId: string }>
    currentInputs?: Record<string, number>
    currentOutputs?: Record<string, number>
    recipeId?: string
    recipeVersion?: number
    lineId?: string
  }
  const contextHash = sha256(snapshotJson)
  const ioSpec = JSON.parse(modelRow.ioSpecJson || '{}') as { allNodes?: string[], historySteps?: number, horizonSteps?: number }
  const allNodes = ioSpec.allNodes ?? []
  const historySteps = Number(ioSpec.historySteps ?? 0)
  const horizonSteps = Number(ioSpec.horizonSteps ?? 0)
  const rawHistory = context.history ?? []
  if (!allNodes.length || !historySteps || rawHistory.length !== historySteps) {
    throw new AppError(422, 'CROSSCHECK_CONTEXT_INVALID', `冻结快照 history 形状与 io_spec 不符(history=${rawHistory.length},期望 ${historySteps})`)
  }
  // 按 nodeId 把 spec.variables 序重排到 allNodes 序(predictor 吃 allNodes 列序);缺失节点 → fail
  const varNodes = (context.variables ?? []).map(v => v.nodeId)
  const columnsByNode = new Map<string, number[]>()
  for (let f = 0; f < varNodes.length; f++) {
    columnsByNode.set(varNodes[f]!, rawHistory.map(rowValues => rowValues[f] ?? Number.NaN))
  }
  const missingNodes = allNodes.filter(n => !columnsByNode.has(n))
  const history = Array.from({ length: historySteps }, (_, h) =>
    allNodes.map(node => columnsByNode.get(node)?.[h] ?? Number.NaN))
  if (missingNodes.length) {
    return getCrosscheckRepo().append({
      recommendationId, runId: rec.runId, modelId, modelArtifactHash: rec.modelArtifactHash,
      contextHash, inputDistance: {}, predicted: [], replayed: [], devPerCv: [],
      tol: optimizerCrosscheckTol(), qhatPerCv: [], verdict: 'fail',
      conditionChanged: false, reason: `冻结快照缺少节点列:${missingNodes.join(',')}`,
    })
  }
  // history 前段 NaN → verdict=fail(D7:不抛异常)
  const hasNaN = history.some(rowValues => rowValues.some(v => !Number.isFinite(v)))
  if (hasNaN) {
    return getCrosscheckRepo().append({
      recommendationId, runId: rec.runId, modelId, modelArtifactHash: rec.modelArtifactHash,
      contextHash, inputDistance: {}, predicted: [], replayed: [], devPerCv: [],
      tol: optimizerCrosscheckTol(), qhatPerCv: [], verdict: 'fail',
      conditionChanged: false, reason: '冻结快照 history 含 NaN/非有限值',
    })
  }

  const candidate = rt.db.prepare('SELECT controls_json AS controlsJson, predicted_json AS predictedJson FROM optimizer_candidates WHERE id = ?')
    .get(rec.candidateId) as { controlsJson: string, predictedJson: string } | undefined
  if (!candidate) throw new AppError(404, 'CANDIDATE_NOT_FOUND', `候选 ${rec.candidateId} 不存在`)
  const predicted = JSON.parse(candidate.predictedJson || '[]') as number[][]
  const controls = JSON.parse(candidate.controlsJson || '[]') as number[][]
  // D7:predictor steps 被 clamp 到 io.horizonSteps;与 candidate.predicted 长度不等 → 422(不给假互校)
  if (predicted.length > horizonSteps) {
    throw new AppError(422, 'CROSSCHECK_STEPS_INVALID', `候选预测步数 ${predicted.length} 超出工件时域 ${horizonSteps};请重新 solve`)
  }

  const replay = await predictWithModel(modelId, { history, controls, steps: predicted.length })
  const replayedForecast = replay.forecast

  // D1 逐 CV 无量纲一致性门:分母取工件 norm.y.std(模型单位);缺失 → not_applicable(禁 scale 兜底)
  const artifact = JSON.parse(readFileSync(join(modelRow.path, 'model.json'), 'utf8')) as {
    norm?: { u?: { mean: number[], std: number[] }, y?: { mean: number[], std: number[] } }
    uq?: { qhatPerCv?: number[] }
    mvOrder?: string[]
    cvOrder?: string[]
  }
  const normStd = artifact.norm?.y?.std
  // D4 inputDistance 快照(与 manager 同口径;此处仅入行存证)
  let distanceSnapshot: Record<string, unknown> = {}
  try {
    const { inputDistance } = await import('./uq-evidence')
    if (artifact.norm?.u && artifact.norm?.y && artifact.mvOrder && artifact.cvOrder) {
      const d = inputDistance({
        currentU: artifact.mvOrder.map(id => context.currentInputs?.[id]),
        currentY: artifact.cvOrder.map(id => context.currentOutputs?.[id]),
        normU: artifact.norm.u, normY: artifact.norm.y,
      })
      distanceSnapshot = { inputDistance: d }
    }
  }
  catch { /* uq-evidence 不可用(极端单测环境)→ 空快照 */ }
  if (!Array.isArray(normStd) || normStd.length === 0) {
    return getCrosscheckRepo().append({
      recommendationId, runId: rec.runId, modelId, modelArtifactHash: rec.modelArtifactHash,
      contextHash, inputDistance: {}, predicted, replayed: replayedForecast, devPerCv: [],
      tol: optimizerCrosscheckTol(), qhatPerCv: artifact.uq?.qhatPerCv ?? [], verdict: 'not_applicable',
      conditionChanged: false, reason: '工件缺 norm.y.std;无量纲化不可达',
    })
  }
  const tol = optimizerCrosscheckTol()
  const cvCount = Math.min(predicted[0]?.length ?? 0, replayedForecast[0]?.length ?? 0, normStd.length)
  const devPerCv: number[] = []
  for (let j = 0; j < cvCount; j++) {
    let maxDev = 0
    for (let t = 0; t < predicted.length; t++) {
      const a = predicted[t]?.[j]
      const b = replayedForecast[t]?.[j]
      if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
        maxDev = Number.POSITIVE_INFINITY
        break
      }
      maxDev = Math.max(maxDev, Math.abs(a - b) / Math.max(1e-9, normStd[j] ?? 1e-9))
    }
    devPerCv.push(maxDev)
  }
  const maxDev = devPerCv.length ? Math.max(...devPerCv) : Number.POSITIVE_INFINITY
  const verdict: CrosscheckRow['verdict'] = Number.isFinite(maxDev) && maxDev <= tol ? 'pass' : 'fail'

  // 工况是否已变(只标注,不拦截互校;dispatch 门另有 D12 谓词):活动 LineRun 的配方版本 vs 快照冻结值
  let conditionChanged = false
  try {
    const { getActiveLineRun } = await import('../dcw/line-run')
    const active = getActiveLineRun(context.lineId ?? '')
    if (active) {
      const recipeDrifted = active.recipeId !== context.recipeId
        || ((context.recipeVersion ?? 0) !== 0 && active.recipeVersion !== context.recipeVersion)
      conditionChanged = !!context.recipeId && recipeDrifted
    }
  }
  catch { /* line-run registry 未装配(单测)→ 不标注 */ }

  return getCrosscheckRepo().append({
    recommendationId, runId: rec.runId, modelId, modelArtifactHash: rec.modelArtifactHash,
    contextHash, inputDistance: distanceSnapshot, predicted, replayed: replayedForecast, devPerCv,
    tol, qhatPerCv: artifact.uq?.qhatPerCv ?? [], verdict,
    conditionChanged, reason: verdict === 'pass' ? `双实现一致(maxDev=${maxDev.toExponential(3)} ≤ tol=${tol})` : `偏差超容差(maxDev=${Number.isFinite(maxDev) ? maxDev.toExponential(3) : '∞'} > tol=${tol})`,
  })
}
