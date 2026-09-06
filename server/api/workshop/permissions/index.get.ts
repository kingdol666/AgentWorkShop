/**
 * GET /api/workshop/permissions —— 产线授权管理面(admin 专用)。
 * 返回全量产线 + 全部用户(基本信息 + 各自 channels + 当前产线授权)。
 */
import { resolveUser, requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { userRepository } from '@/server/repositories/user.repository'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  requireAdmin(event)
  const lines = getDcwController().listLines()
  const manager = getWorkshopManager()
  const users = userRepository.list({ page: 1, pageSize: 1000 })
  const out = users.items.map(u => ({
    ...u,
    channels: manager.listChannelsForUser(u.id).map(c => ({ id: c.channelId, name: c.name, createdAt: c.createdAt })),
    grants: userRepository.listGrants(u.id),
  }))
  return { lines, users: out }
})
