/**
 * POST /api/workshop/ops-logs —— 人工手动记录事件(运维数字化:值班记录/现场处置/备注)。
 * body: { summary(必填), lineId?, productId?, recipeId?, detail? }
 * 入 audit_log(kind='manual')+ 广播 ops.log 实时帧,与自动操作同一流水可联合查询。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { recordOps } from '../../../services/workshop/ops/ops'

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
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'ops.manual',
    kind: 'manual',
    targetKind: 'manual-log',
    targetId: '',
    summary,
    lineId: body.lineId ?? '',
    productId: body.productId ?? '',
    recipeId: body.recipeId ?? '',
    detail: { manual: true, ...(body.detail ?? {}) },
  })
  return { ok: true }
})
