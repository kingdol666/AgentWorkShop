/**
 * DELETE /api/workshop/aml/models/:id —— 删除模型(元数据行 + 实体目录)。
 * 保护:production 阶段的模型拒绝直接删除(在线预测依赖它),须先退役为 retired。
 * 权限:admin/editor + 产线 operate。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { removeEntityDir } from '@/server/services/workshop/aml/entity'
import { assertModelNotReferenced } from '@/server/services/workshop/aml/model-references'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(id)
  if (!model) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${id} 不存在`)
  requireLineMode(user, rt.repo.dataset.get(model.datasetId)?.lineId, 'operate')
  if (model.stage === 'production') {
    throw new AppError(409, 'AML_MODEL_IN_PRODUCTION',
      `模型 ${id} 处于 production 阶段,在线预测依赖它,拒绝删除。请先晋升同组新模型或将其退役(retired)后再删。`)
  }
  // C13/A19:被 Channel profile / 训练计划 / Optimizer Profile / 在途租约引用时拒绝删除
  assertModelNotReferenced(rt.db, id)
  const ent = removeEntityDir(rt, 'model', id)
  rt.repo.model.remove(id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.model.delete', kind: 'system',
    summary: `删除模型 ${id}(阶段 ${model.stage})${ent.removed ? ',含实体目录' : ''}`,
    targetKind: 'aml_model', targetId: id,
  })
  return { deleted: true, entityRemoved: ent.removed, dir: ent.dir }
})
