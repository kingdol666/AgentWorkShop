/**
 * POST /api/workshop/aml/env/recheck —— 清空 uv/Python 探测缓存并重新探测。
 * 场景:用户在系统里手工装了 uv 或 Python,不想重启服务就让它生效。
 * 之后读 GET /aml/env 即拿到最新结论。
 */
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { envStatus, recheck } from '@/server/services/workshop/aml/env-manager'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin', 'editor'])
  recheck()
  return envStatus()
})
