/**
 * GET /api/workshop/tools —— 全局工具目录(admin)。
 * 返回内置 + 插件工具的元数据、可用状态、被哪些 Channel 停用。
 */
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { buildGlobalToolView } from '@/server/services/workshop/tools/catalog-view'

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  return buildGlobalToolView()
})
