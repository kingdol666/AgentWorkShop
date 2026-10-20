/**
 * GET /api/workshop/tools/:name —— 单工具详情(admin)。
 */
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { buildGlobalToolView } from '@/server/services/workshop/tools/catalog-view'
import { AppError, ErrorCodes } from '@/server/utils/errors'

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  const name = String(event.context.params?.name ?? '')
  const tool = buildGlobalToolView().tools.find(t => t.name === name)
  if (!tool) throw new AppError(404, ErrorCodes.NOT_FOUND, `工具不存在: ${name}`)
  return tool
})
