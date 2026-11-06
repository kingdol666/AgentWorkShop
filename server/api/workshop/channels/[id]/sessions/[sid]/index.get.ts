/**
 * GET /api/workshop/channels/:id/sessions/:sid —— 单会话详情（memberMap 已解析）。
 * 只读面：可见性同会话清单；sid 不存在或不属于该频道 → 404 NOT_FOUND。
 */
import { getRouterParam } from 'h3'
import { AppError } from '@/server/utils/errors'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

/** memberMapJson → { baseId: cloneId }（容错：坏 JSON 视为空映射） */
function parseMemberMap(raw: string | undefined): Record<string, string> {
  try {
    return JSON.parse(raw ?? '{}')
  }
  catch {
    return {}
  }
}

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)
  const s = manager.getChannelSession(sessionId)
  if (!s || s.channelId !== channelId) {
    throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
  }
  return {
    id: s.id,
    channelId: s.channelId,
    title: s.title,
    status: s.status,
    memoryPolicy: s.memoryPolicy,
    memberMap: parseMemberMap(s.memberMapJson),
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    closedAt: s.closedAt,
    projectId: s.projectId,
    projectWorkItemId: s.projectWorkItemId,
    createdByKind: s.createdByKind,
    instanceKind: s.instanceKind,
  }
})
