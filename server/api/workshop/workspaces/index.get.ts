/**
 * GET /api/workshop/workspaces —— 当前用户的 workspace 列表(含挂载 channel;Bearer 用户 token)。
 */
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../caller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getWorkshopManager().listWorkspaces(user.id)
})
