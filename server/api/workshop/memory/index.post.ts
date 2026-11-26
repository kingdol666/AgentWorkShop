/**
 * POST /api/workshop/memory —— 人工新建记忆条目（author_kind=human）。
 * body: { channelId, title, content, scopeKind?, scopeKey?, importance?, agentId? }
 */
import { readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { createMemory } from '@/server/services/workshop/memory/memory-admin'
import { requireMemoryUser } from '@/server/services/workshop/memory/memory-access'
import type { MemoryScopeKind } from '@/server/services/workshop/db/database'

export default defineApiHandler(async (event) => {
  const { user, actor } = requireMemoryUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const db = getAmlRuntime().db
  const channelId = String(body.channelId ?? '').trim()
  if (!channelId) throw new AppError(422, 'CHANNEL_REQUIRED', 'channelId 必填')
  const title = String(body.title ?? '').trim()
  if (!title) throw new AppError(422, 'TITLE_REQUIRED', 'title 必填')
  if (user.role !== 'admin') {
    const ch = db.prepare('SELECT owner_user_id AS owner FROM channels WHERE id = ?').get(channelId) as { owner?: string | null } | undefined
    if (!ch) throw new AppError(404, 'CHANNEL_NOT_FOUND', '频道不存在')
    if ((ch.owner ?? null) !== user.id) throw new AppError(403, 'FORBIDDEN', '仅频道 owner 可新建该频道记忆')
  }
  const scopeKind = (typeof body.scopeKind === 'string' ? body.scopeKind : 'channel') as MemoryScopeKind
  if (!['session', 'channel', 'line', 'product', 'global'].includes(scopeKind)) {
    throw new AppError(422, 'INVALID_SCOPE', 'scopeKind 非法')
  }
  return createMemory(db, {
    channelId,
    agentId: typeof body.agentId === 'string' && body.agentId ? body.agentId : undefined,
    scopeKind,
    scopeKey: typeof body.scopeKey === 'string' ? body.scopeKey : '',
    title,
    content: String(body.content ?? ''),
    importance: typeof body.importance === 'number' ? body.importance : undefined,
    ownerUserId: user.id,
    actor,
  })
})
