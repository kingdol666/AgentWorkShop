/**
 * PATCH /api/workshop/channels/:id/memory-access-mode —— 频道/会话访问策略。
 * body: { mode, sessionId? }；sessionId 存在时只改会话覆盖，频道默认不变。
 */
import { getRouterParam, readBody } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { recordOps } from '../../../../../services/workshop/ops/ops'

const MODES = new Set(['inherit', 'isolated', 'disabled', 'readonly'])

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const mode = String(body.mode ?? '')
  if (!MODES.has(mode)) throw new AppError(422, 'INVALID_MODE', 'mode 必须是 inherit/isolated/disabled/readonly')
  const sessionId = String(body.sessionId ?? '').trim()
  const db = manager.deps.db
  const at = new Date().toISOString()
  if (sessionId) {
    const session = db.prepare('SELECT id FROM channel_sessions WHERE id = ? AND channel_id = ?').get(sessionId, channelId)
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', '会话不存在或不属于该频道')
    db.prepare('UPDATE channel_sessions SET memory_access_mode = ? WHERE id = ?').run(mode, sessionId)
  }
  else {
    db.prepare('UPDATE channels SET memory_access_mode = ?, updated_at = ? WHERE id = ?').run(mode, at, channelId)
  }
  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: sessionId ? 'memory.access_mode.session.update' : 'memory.access_mode.update',
      kind: 'system',
      targetKind: sessionId ? 'session' : 'channel',
      targetId: sessionId || channelId,
      summary: `记忆访问策略 → ${mode}${sessionId ? `（会话 ${sessionId}）` : ''}`,
      lineId: channel.lineId ?? '',
    })
  }
  catch { /* 审计失败不影响策略 */ }
  return { scope: sessionId ? 'session' : 'channel', sessionId: sessionId || undefined, mode }
})
