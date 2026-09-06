/**
 * GET /api/workshop/dcw/recipes/:id/versions —— 配方参数版本历史(旧→新,尾行=当前版)。
 * 每条:version/at/by(来源)/actorName(人话操作者)/description(变更原因)/params。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  return { versions: getDcwController().recipeVersions(id) }
})
