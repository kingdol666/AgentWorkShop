/**
 * POST /api/workshop/ops-logs —— 人工手动记录事件(值班记录/现场处置/备注/异常上报)。
 * body: { summary(必填), lineId?, productId?, recipeId?, detail?, level? }
 *
 * level(2026-10-29):人工记录也带严重级 —— 值班员上报异常时选 warn/error,
 * 记录在 /logs 与实时轨带红黄标,与自动 error-ledger/写控 ACK 同一口径。
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
import { requireLineForResource } from '@/server/services/workshop/line-scope'

const MANUAL_LEVELS = ['info', 'warn', 'error'] as const
/** 防御上限:摘要 2k 字符 / 详情 32KB(超限 400 拒绝,防单条日志撑爆 sqlite 与前端渲染) */
const SUMMARY_MAX_CHARS = 2000
const DETAIL_MAX_BYTES = 32 * 1024

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{
    summary?: string
    lineId?: string
    productId?: string
    recipeId?: string
    detail?: Record<string, unknown>
    level?: string
  }>(event) ?? {}
  const summary = String(body.summary ?? '').trim()
  if (!summary)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '手动记录内容(summary)不能为空')
  if (summary.length > SUMMARY_MAX_CHARS)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `手动记录内容超长:${summary.length} 字符(上限 ${SUMMARY_MAX_CHARS},长文请放附件/文档后引用)`)
  if (body.detail !== undefined && JSON.stringify(body.detail ?? {}).length > DETAIL_MAX_BYTES)
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `手动记录详情过大(序列化后超 ${DETAIL_MAX_BYTES} 字节);大段内容请落文档后在此引用`)
  const levelInput = String(body.level ?? 'info').trim()
  if (!MANUAL_LEVELS.includes(levelInput as typeof MANUAL_LEVELS[number]))
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `level 只支持 info/warn/error,收到: ${levelInput}`)
  const level = levelInput as typeof MANUAL_LEVELS[number]

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

  // 产线归属归一后统一授权:写产线日志需要该线 operate;
  // lineId 为空 = 全局审计台账(跨线运维信息),仅 admin 可写(与 GET 收权同口径)。
  requireLineForResource(user, lineId, '运行日志', 'operate')

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
    level,
    detail: { manual: true, ...(body.detail ?? {}) },
  })
  return { ok: true, lineScoped: Boolean(lineId), lineId, productId, recipeId }
})
