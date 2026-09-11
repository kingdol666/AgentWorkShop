/**
 * GET /api/workshop/users/me —— 当前用户信息(Bearer 用户 token)。
 * 附带资源统计(owned channels/templates/teams/workspaces)。
 *
 * role 必须回传:前端据它决定是否渲染「权限管理 / 用户管理 / 配方应用」等
 * admin/editor 专属入口。早先这里漏了 role,前端只能靠试错(点进去吃 403)
 * 或另开 /users 列表接口去猜自己的角色。
 */
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveUser } from '../caller'

export default defineApiHandler(async (event) => {
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channels = manager.listChannelsForUser(user.id)
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    stats: {
      ownedChannels: channels.filter(c => c.ownerUserId === user.id).length,
      legacyChannels: channels.filter(c => c.ownerUserId === null).length,
      workspaces: manager.listWorkspaces(user.id).length,
    },
  }
})
