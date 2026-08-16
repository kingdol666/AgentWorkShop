/**
 * DELETE /api/workshop/workspaces/:id —— 删除 workspace(仅 owner)。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { resolveUser } from '../../caller'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const workspaceId = getRouterParam(event, 'id')!
  getWorkshopManager().deleteWorkspace(user.id, workspaceId)
  return { ok: true, workspaceId }
})
