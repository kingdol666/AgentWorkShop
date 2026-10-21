/**
 * POST /api/workshop/eda/vm/predict —— E6 软测量推理入口(特征向量 → 模型)。
 * body: { model_id, run_id, node_ids? } —— 语义见 services/workshop/eda/vm.ts。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode, requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { predictWithModel } from '@/server/services/workshop/aml/predictor'
import { listFeatures } from '@/server/services/workshop/eda/features'
import { edaRunById } from '@/server/services/workshop/eda/eda-run.repo'

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
  const wanted = (body.node_ids ?? []).filter(Boolean)
  const feats = listFeatures({ runId, limit: 500 }).filter(f => f.segment === '' && f.mean != null)
  const byNode = new Map(feats.map(f => [f.nodeId, f.mean as number]))
  const vectorNodes = wanted.length ? wanted : feats.map(f => f.nodeId)
  const vector = vectorNodes.map(id => byNode.get(id) ?? 0)
  const missing = vectorNodes.filter(id => !byNode.has(id))
  if (!vector.length) throw new AppError(400, 'VALIDATION_ERROR' as never, `批次 ${runId} 无特征行;请先跑特征提取(关账自动或 POST /eda/features/run)。`)
  const prediction = await predictWithModel(modelId, { history: [vector], steps: 1 })
  return { runId, vectorNodes, missing, vector, prediction }
})
