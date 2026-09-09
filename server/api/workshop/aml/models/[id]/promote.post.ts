/**
 * POST /api/workshop/aml/models/:id/promote —— 阶段晋升/退役(人工操作;body: {toStage})。
 * 权限 = 产线 operate;production 晋升前做 ONNX 深检;同组旧 production 自动 retired。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { transitionModel } from '@/server/services/workshop/aml/model-registry'
import { verifyModelArtifact } from '@/server/services/workshop/aml/predictor'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ toStage?: 'shadow' | 'production' | 'retired' }>(event) ?? {}
  if (!body.toStage) throw new AppError(422, 'AML_SPEC_INVALID', '缺少 toStage(shadow|production|retired)')
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(id)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${id} 不存在`)
  const ds = rt.repo.dataset.get(model.datasetId)
  requireLineMode(user, ds?.lineId, 'operate')
  if (body.toStage === 'production') {
    const check = await verifyModelArtifact(id)
    if (!check.ok) throw new AppError(422, 'AML_ARTIFACT_INVALID', `生产晋升前工件深检失败:${check.detail}`)
  }
  const result = transitionModel(id, body.toStage, user.name || user.id, 'user')
  return result
})
