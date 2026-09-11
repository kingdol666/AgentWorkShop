/**
 * DELETE /api/workshop/aml/datasets/:id —— 删除数据集(元数据行 + 实体目录)。
 * 引用保护:被实验或模型引用的数据集**拒绝删除**(否则模型工件会指向不存在的数据源,
 * 训练可复现性断裂)。需要连带删除时先删对应作业/模型。
 * 权限:admin/editor + 产线 operate。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { removeEntityDir } from '@/server/services/workshop/aml/entity'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const rt = getAmlRuntime()
  const row = rt.repo.dataset.get(id)
  if (!row) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${id} 不存在`)
  requireLineMode(user, row.lineId, 'operate')

  const refs = rt.repo.dataset.referenceCount(id)
  if (refs.experiments > 0 || refs.models > 0) {
    throw new AppError(409, 'AML_DATASET_REFERENCED',
      `数据集 ${id} 仍被引用(实验 ${refs.experiments} 条 / 模型 ${refs.models} 个),拒绝删除。请先删除对应作业与模型,以保住模型的可复现性溯源。`)
  }
  const ent = removeEntityDir(rt, 'dataset', id)
  rt.repo.dataset.remove(id)
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.dataset.delete', kind: 'system',
    summary: `删除数据集 ${id}${ent.removed ? '(含实体目录)' : '(实体目录本就不存在)'}`,
    targetKind: 'aml_dataset', targetId: id,
    lineId: row.lineId, productId: row.productId, recipeId: row.recipeId,
  })
  return { deleted: true, entityRemoved: ent.removed, dir: ent.dir }
})
