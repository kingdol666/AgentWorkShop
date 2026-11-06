/**
 * GET /api/workshop/channels/:id/sessions —— 会话清单（含成员映射与状态）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(ch.ownerUserId, user, 'channel')
  const sessions = manager.listChannelSessions(channelId)
  return sessions.map(s => ({
    id: s.id,
    title: s.title,
    status: s.status,
    memoryPolicy: s.memoryPolicy,
    memberMap: (() => { try { return JSON.parse(s.memberMapJson ?? '{}') } catch { return {} } })(),
    createdAt: s.createdAt,
    closedAt: s.closedAt,
  }))
})
