/**
 * POST /api/workshop/memory/embedding/backfill —— 存量记忆向量回填（admin）。
 * body: { rebuild?: boolean, limit?: number, budgetMs?: number }
 *
 * 换模型后必须 rebuild（旧向量空间不可比）；首次启用可直接回填缺失行。
 * 返回 remaining —— UI 反复调用直到 0（每次默认 64 条/25s，不占死事件循环）。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '@/server/utils/validate'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import { backfillEmbeddings } from '@/server/services/workshop/memory/local-embedding/backfill'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'

const bodySchema = z.object({
  rebuild: z.boolean().optional(),
  limit: z.number().int().min(1).max(512).optional(),
  budgetMs: z.number().int().min(1000).max(120_000).optional(),
})

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '仅管理员可回填向量')
  const body = await readValidatedBody(event, zValidator(bodySchema))
  try {
    const result = await backfillEmbeddings(getAmlRuntime().db, {
      ...(body.rebuild !== undefined ? { rebuild: body.rebuild } : {}),
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      ...(body.budgetMs !== undefined ? { timeBudgetMs: body.budgetMs } : {}),
    })
    return result
  }
  catch (err) {
    throw new AppError(409, 'BACKFILL_UNAVAILABLE', String((err as Error)?.message ?? err))
  }
})
