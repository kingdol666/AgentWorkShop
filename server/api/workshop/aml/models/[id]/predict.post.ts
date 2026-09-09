/**
 * POST /api/workshop/aml/models/:id/predict —— what-if 预测(显式模型;需产线只读权限)。
 * body: { history: number[][], controls?: number[][], steps? }
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { predictWithModel } from '@/server/services/workshop/aml/predictor'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ history?: number[][], controls?: number[][], steps?: number }>(event) ?? {}
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(id)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${id} 不存在`)
  const ds = rt.repo.dataset.get(model.datasetId)
  if (!ds) throw new AppError(404, 'AML_DATASET_MISSING', `模型 ${id} 关联的数据集已被清理`)
  requireLineMode(user, ds.lineId, 'readonly')
  return { prediction: await predictWithModel(id, { history: body.history ?? [], controls: body.controls, steps: body.steps }) }
})
