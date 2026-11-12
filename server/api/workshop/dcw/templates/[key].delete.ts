/**
 * DELETE /api/workshop/dcw/templates/:key —— 删除自定义控制模板(内置拒绝)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwTemplateRegistry } from '@/server/services/workshop/dcw/dcw-templates'
import { assertAssetManager } from '@/server/utils/asset-auth'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  assertAssetManager(user, '删除控制模板')
  const key = getRouterParam(event, 'key') ?? ''
  const removed = getDcwTemplateRegistry().remove(key)
  return { removed: removed.key }
})
