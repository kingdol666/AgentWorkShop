/**
 * PATCH /api/workshop/aml/models/:id —— 更新模型元数据(备注)。
 * body: { note: string }
 * 阶段变更不走这里(必须走 /promote,那里有 ONNX 深检与同组唯一性保护)。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ note?: string }>(event) ?? {}
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(id)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${id} 不存在`)
  requireLineMode(user, rt.repo.dataset.get(model.datasetId)?.lineId, 'operate')
  if (typeof body.note === 'string') rt.repo.model.updateNote(id, body.note.slice(0, 2000))
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.model.update', kind: 'system',
    summary: `更新模型 ${id} 元数据(备注)`,
    targetKind: 'aml_model', targetId: id,
  })
  return { model: rt.repo.model.get(id) }
})
