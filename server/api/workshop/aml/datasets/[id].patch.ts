/**
 * PATCH /api/workshop/aml/datasets/:id —— 更新数据集元数据(备注)。
 * body: { note: string }
 * 仅改元数据(可检索的描述信息);实体数据不可变(数据集的 sha256 是训练可复现性的锚)。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ note?: string }>(event) ?? {}
  const rt = getAmlRuntime()
  const row = rt.repo.dataset.get(id)
  if (!row) return { dataset: null }
  requireLineMode(user, row.lineId, 'operate')
  if (typeof body.note === 'string') rt.repo.dataset.updateNote(id, body.note.slice(0, 2000))
  recordOps({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: 'aml.dataset.update', kind: 'system',
    summary: `更新数据集 ${id} 元数据(备注)`,
    targetKind: 'aml_dataset', targetId: id,
    lineId: row.lineId, productId: row.productId, recipeId: row.recipeId,
  })
  return { dataset: rt.repo.dataset.get(id) }
})
