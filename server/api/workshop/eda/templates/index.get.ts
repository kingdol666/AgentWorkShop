/**
 * GET /api/workshop/eda/templates —— 我的图表配置模板列表(admin 可见全部)。
 */
import { defineApiHandler } from '@/server/utils/response'
import { resolveUser } from '@/server/api/workshop/caller'
import { listTemplates } from '@/server/services/workshop/eda/template-repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return { templates: listTemplates(user) }
})
