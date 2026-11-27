/**
 * GET/POST /api/workshop/channels/:id/memory-blocks —— 核心块管理（批次 J）。
 */
import { getRouterParam, readBody } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { appendBlock, blockRevisions, listBlocks, rollbackBlock, scopeIdOfChannel, scopeIdOfSession, setBlockLocked, upsertBlock } from '../../../../../services/workshop/memory/blocks'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const db = getAmlRuntime().db
  if ((event.method?.toUpperCase() ?? 'GET') === 'GET') {
    return { items: listBlocks(db, [scopeIdOfChannel(channelId)]) }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const action = String(body.action ?? 'replace')
  // Scope 必须由 URL 频道推导：body.scopeId 是历史字段，不能作为授权边界
  // （否则拥有频道 A 的用户可改写频道 B 的 core block，并被 B 的 Agent 注入）。
  const sessionId = String(body.sessionId ?? '').trim()
  let scopeId = scopeIdOfChannel(channelId)
  if (sessionId) {
    const session = db.prepare('SELECT id FROM channel_sessions WHERE id = ? AND channel_id = ?').get(sessionId, channelId)
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', '会话不存在或不属于该频道')
    scopeId = scopeIdOfSession(sessionId)
  }
  const requestedScope = String(body.scopeId ?? '').trim()
  if (requestedScope && requestedScope !== scopeId) {
    throw new AppError(422, 'SCOPE_MISMATCH', 'scopeId 必须与当前频道/会话一致')
  }
  const label = String(body.label ?? '')
  if (!label) throw new AppError(422, 'LABEL_REQUIRED', 'label 必填')
  if (action === 'rollback') {
    const ok = rollbackBlock(db, scopeId, label, Number(body.revision), user.id)
    if (!ok) throw new AppError(404, 'REVISION_NOT_FOUND', '目标版本不存在')
    return { ok }
  }
  if (action === 'lock') {
    const ok = setBlockLocked(db, scopeId, label, body.locked !== false, user.id)
    return { ok }
  }
  if (action === 'revisions') return { items: blockRevisions(db, scopeId, label) }
  const input = {
    scopeId, channelId, label, value: String(body.value ?? ''), description: String(body.description ?? ''),
    limitChars: Number(body.limitChars ?? 2000), actor: user.id, human: true,
  }
  const out = action === 'append' ? appendBlock(db, input) : upsertBlock(db, input)
  return { block: out.block, truncated: out.truncated }
})
