/**
 * POST /api/workshop/eda/vm/predict —— E6 软测量推理入口(特征向量 → 模型)。
 * body: { model_id, run_id, node_ids? }
 *
 * 形状对齐(评审 E6②):向量按模型 io_spec.allNodes 重排(缺节点补 0 并如实列入
 * missing),再平铺成 [historySteps][nAll](特征是 per-run 标量,历史窗恒定);
 * OOD 拒判(评审 E6③):以参考带(该节点最近 ≤10 个未违例批次的 mean 的 mean±std,
 * 与 FDC 同源)逐维 |z| 均值为输入距离,过 evaluateEnsemble 统一闸门 —— 拒判时
 * 响应带 ood.rejectCode 而非预测值(UQ/OOD 语义与 AML 面同源,复用 evaluateEnsemble)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode, requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { predictWithModel } from '@/server/services/workshop/aml/predictor'
import { parseIoSpec } from '@/server/services/workshop/aml/model-registry'
import { evaluateEnsemble } from '@/server/services/workshop/aml/twin/uq-ood'
import { edaDb } from '@/server/services/workshop/eda/eda-db'
import { listFeatures } from '@/server/services/workshop/eda/features'
import { edaRunById } from '@/server/services/workshop/eda/eda-run.repo'

/** 参考带基线:同 FDC referenceBand 口径(最近 ≤10 个未违例行;≥3 行才有效) */
function referenceStats(nodeId: string, metric: string): { mean: number, std: number } | null {
  const rows = edaDb().prepare(`
    SELECT f.mean FROM eda_run_features f JOIN eda_runs r ON r.id = f.run_id
    WHERE f.node_id = ? AND f.metric = ? AND f.segment = '' AND f.violated = 0 AND f.mean IS NOT NULL
    ORDER BY f.created_at DESC LIMIT 10
  `).all(nodeId, metric) as Array<{ mean: number | null }>
  const means = rows.map(r => Number(r.mean)).filter(Number.isFinite)
  if (means.length < 3) return null
  const m = means.reduce((a, b) => a + b, 0) / means.length
  const s = Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / means.length)
  if (!Number.isFinite(m) || !Number.isFinite(s) || s < 1e-12) return null
  return { mean: m, std: s }
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ model_id?: string, run_id?: string, node_ids?: string[] }>(event) ?? {}
  const modelId = String(body.model_id ?? '')
  const runId = String(body.run_id ?? '')
  if (!modelId || !runId) throw new AppError(400, 'VALIDATION_ERROR' as never, 'model_id 与 run_id 必填。')
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(modelId)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING' as never, `模型 ${modelId} 不存在`)
  if (model.purpose !== 'virtual_metrology') {
    throw new AppError(400, 'VALIDATION_ERROR' as never, `模型 ${modelId} 的 purpose=${model.purpose},非 virtual_metrology;VM 推理请用 VM 模型。`)
  }
  const ds = rt.repo.dataset.get(model.datasetId)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING' as never, `模型 ${modelId} 关联的数据集已被清理`)
  requireLineMode(user, ds.lineId, 'readonly')
  const run = edaRunById(runId)
  if (!run) throw new AppError(404, 'NOT_FOUND' as never, `批次不存在: ${runId}`)
  if (lineMode(user, run.lineId) === 'none') throw new AppError(403, 'SCOPE_VIOLATION' as never, '批次不在你的可读产线上。')

  // 特征向量按 io_spec.allNodes 重排(E6②):顺序/长度与 predictor 期望一致,否则必 422
  const io = parseIoSpec(model) as unknown as { historySteps: number, allNodes: string[] }
  const allNodes: string[] = io.allNodes ?? []
  if (!allNodes.length) throw new AppError(400, 'VALIDATION_ERROR' as never, `模型 ${modelId} 的 io_spec 无 allNodes,无法对齐特征向量。`)
  const feats = listFeatures({ runId, limit: 500 }).filter(f => f.segment === '' && f.mean != null)
  const byNode = new Map(feats.map(f => [f.nodeId, { mean: f.mean as number, metric: f.metric }]))
  const vector = allNodes.map(id => byNode.get(id)?.mean ?? 0)
  const missing = allNodes.filter(id => !byNode.has(id))
  if (!missing.length && !feats.length) {
    throw new AppError(400, 'VALIDATION_ERROR' as never, `批次 ${runId} 无特征行;请先跑特征提取(关账自动或 POST /eda/features/run)。`)
  }

  const historySteps = Math.max(1, Math.round(Number(io.historySteps) || 1))
  const prediction = await predictWithModel(modelId, {
    history: Array.from({ length: historySteps }, () => vector),
    steps: 1,
  })

  // OOD 闸门(E6③):逐维 |z|(相对参考带)的均值作输入距离;基线不足 → 距离 0 放行并标注 unguarded
  const zByNode = allNodes.map((id) => {
    const f = byNode.get(id)
    if (!f) return null
    const ref = referenceStats(id, f.metric)
    if (!ref) return null
    return Math.abs((f.mean - ref.mean) / ref.std)
  })
  const zValid = zByNode.filter((z): z is number => z != null)
  const inputDistance = zValid.length ? zValid.reduce((a, b) => a + b, 0) / zValid.length : 0
  const ood = evaluateEnsemble(
    {
      predictions: [Object.fromEntries((prediction.targetNodes ?? []).map((tn, i) => [tn, prediction.forecast?.[0]?.[i] ?? 0]))],
      inputDistance,
    },
    { coverageTarget: 0, distanceThreshold: 3, disagreementThreshold: 1, calibrationFresh: true },
  )
  if (!ood.accepted) {
    return { runId, rejected: true, ood, inputDistance, guardedNodes: zValid.length, vectorNodes: allNodes, missing, vector }
  }
  return { runId, vectorNodes: allNodes, missing, vector, inputDistance, ood, prediction }
})
