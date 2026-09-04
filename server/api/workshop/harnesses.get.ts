/**
 * GET /api/workshop/harnesses —— 可用执行引擎注册表(前端下拉/能力徽标)。
 * 数据源 HARNESS_REGISTRY(单一事实源;与 factory/manager 校验同源)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { harnessMetas } from '@/server/services/workshop/agents/registry'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return { harnesses: harnessMetas() }
})
