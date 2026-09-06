/**
 * GET /api/workshop/permissions —— 产线授权管理面(admin 专用)。
 * 返回全量产线 + 全部用户(基本信息 + 各自 channels + 当前产线授权)。
 * 单查询批量取 grants(不逐用户 N+1);requireAdmin 已含鉴权,不重复 resolve。
 */
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { userRepository } from '@/server/repositories/user.repository'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getDcwController } from '@/server/services/workshop/dcw/dcw-controller'

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  const lines = getDcwController().listLines()
  const manager = getWorkshopManager()
  const users = userRepository.listAll()
  const grantsByUser = new Map<string, Array<{ lineId: string, mode: string, grantedBy: string | null, grantedAt: string }>>()
  for (const g of userRepository.allGrants()) {
    const list = grantsByUser.get(g.userId) ?? []
    list.push({ lineId: g.lineId, mode: g.mode, grantedBy: g.grantedBy, grantedAt: g.grantedAt })
    grantsByUser.set(g.userId, list)
  }
  // channel 列表按 owner 归并(每用户一次轻量查询;channel 行自带 ownerUserId)
  const out = users.map(u => ({
    ...u,
    channels: manager.listChannelsForUser(u.id).map(c => ({ id: c.channelId, name: c.name, createdAt: c.createdAt })),
    grants: grantsByUser.get(u.id) ?? [],
  }))
  return { lines, users: out }
})
