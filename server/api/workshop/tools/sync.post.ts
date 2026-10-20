/**
 * POST /api/workshop/tools/sync —— 手动重同步工具目录(admin)。
 * 幂等;返回内置/插件/不可用计数。
 */
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { syncToolRegistry } from '@/server/services/workshop/tools/registry'

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  return syncToolRegistry('manual-api')
})
