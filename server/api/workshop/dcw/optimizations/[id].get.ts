/**
 * GET /api/workshop/dcw/optimizations/:id —— 优化记录详情(含 judge 与指标快照全文)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { getRecipeRollBackManager } from '@/server/services/workshop/dcw/recipe-rollback-manager'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const record = getRecipeRollBackManager().recordById(id)
  if (!record)
    throw new AppError(404, ErrorCodes.NOT_FOUND, `优化记录不存在: ${id}`)
  return { record }
})
