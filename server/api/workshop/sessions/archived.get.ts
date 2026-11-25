/**
 * GET /api/workshop/sessions/archived —— 当前用户可见的已归档会话。
 * 可见性：自己拥有的 Channel + admin 全量；只读目录，恢复/删除走各自频道子路由。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const rows = getWorkshopManager().listArchivedSessions({ id: user.id, role: user.role })
  return rows.map(session => ({
    id: session.id,
    channelId: session.channelId,
    channelName: session.channelName,
    title: session.title,
    status: session.status,
    instanceKind: session.instanceKind,
    createdAt: session.createdAt,
    closedAt: session.closedAt,
    archivedAt: session.archivedAt,
  }))
})
