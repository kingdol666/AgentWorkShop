/**
 * POST /api/workshop/ops-logs —— 人工手动记录事件(值班记录/现场处置/备注)。
 * body: { summary(必填), lineId?, productId?, recipeId?, detail? }
 *
 * 产线归属一致性:给了 productId / recipeId 时自动补全 lineId,并与显式 lineId 交叉校验
 * (不允许把 A 线配方写进 B 线日志)。lineId 为空的记录只进全局审计台账,
 * **不会**出现在产线日志查询与实时轨 —— 前端因此要求先选产线。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { recordOps } from '../../../services/workshop/ops/ops'
import { getDcwLineRepo } from '@/server/services/workshop/dcw/dcw-line.repo'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { getDcwProductRepo } from '@/server/services/workshop/dcw/dcw-product.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{
    summary?: string
    lineId?: string
    productId?: string
    recipeId?: string
    detail?: Record<string, unknown>
  }>(event) ?? {}
  const summary = String(body.summary ?? '').trim()
  if (!summary)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '手动记录内容(summary)不能为空')

  let lineId = String(body.lineId ?? '').trim()
  const productId = String(body.productId ?? '').trim()
  const recipeId = String(body.recipeId ?? '').trim()
  if (lineId && !getDcwLineRepo().byId(lineId))
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产线不存在: ${lineId}`)

  if (productId) {
    const product = getDcwProductRepo().byId(productId)
    if (!product)
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产品不存在: ${productId}`)
    if (lineId && product.lineId && product.lineId !== lineId)
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产品「${product.name}」归属产线 ${product.lineId},与 lineId=${lineId} 不一致`)
    if (!lineId && product.lineId) lineId = product.lineId
  }
  if (recipeId) {
    const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
    if (!recipe)
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `配方不存在: ${recipeId}`)
    if (lineId && recipe.lineId && recipe.lineId !== lineId)
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `配方「${recipe.name}」归属产线 ${recipe.lineId},与 lineId=${lineId} 不一致`)
    if (!lineId && recipe.lineId) lineId = recipe.lineId
  }

  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'ops.manual',
    kind: 'manual',
    targetKind: 'manual-log',
    targetId: '',
    summary,
    lineId,
    productId,
    recipeId,
    detail: { manual: true, ...(body.detail ?? {}) },
  })
  return { ok: true, lineScoped: Boolean(lineId), lineId, productId, recipeId }
})
