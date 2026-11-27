/**
 * GET /api/workshop/channels/:id/memory-access-mode?sessionId= —— 记忆访问策略（频道/会话）。
 */
import { getQuery, getRouterParam } from 'h3'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { AppError } from '../../../../../utils/errors'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const sessionId = String(getQuery(event).sessionId ?? '').trim()
  const db = manager.deps.db
  if (sessionId) {
    const session = db.prepare('SELECT id, memory_access_mode AS mode FROM channel_sessions WHERE id = ? AND channel_id = ?')
      .get(sessionId, channelId) as { id?: string, mode?: string } | undefined
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', '会话不存在或不属于该频道')
    return { scope: 'session', sessionId, mode: session.mode ?? 'inherit' }
  }
  const row = db.prepare('SELECT memory_access_mode AS mode FROM channels WHERE id = ?').get(channelId) as { mode?: string } | undefined
  return { scope: 'channel', mode: row?.mode ?? 'inherit' }
})
