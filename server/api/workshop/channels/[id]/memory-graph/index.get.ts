/** GET /api/workshop/channels/:id/memory-graph —— 按分区返回知识网络子图。 */
import { getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { graphContext } from '@/server/utils/memory-graph-api'

export default defineApiHandler(async (event) => {
  const { channelId, service, ownerUserId, lineId, db } = graphContext(event, false)
  const q = getQuery(event)
  const list = (v: unknown): string[] | undefined => {
    const raw = String(v ?? '').trim()
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined
  }
  const scope = String(q.scope ?? '').trim()
  let scopeKinds = list(q.scopeKinds)
  let scopeKeys = list(q.scopeKeys)
  let ownerFilter: string | undefined
  if (scope === 'channel') {
    scopeKinds = ['channel']
    scopeKeys = ['']
  }
  else if (scope === 'session') {
    const sessionId = String(q.sessionId ?? q.scopeKey ?? '').trim()
    if (!sessionId) throw new AppError(422, 'SESSION_REQUIRED', 'scope=session 需要 sessionId')
    const session = db.prepare('SELECT id FROM channel_sessions WHERE id = ? AND channel_id = ?').get(sessionId, channelId)
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', '会话不存在或不属于该频道')
    scopeKinds = ['session']
    scopeKeys = [sessionId]
  }
  else if (scope === 'shared') {
    if (!ownerUserId) throw new AppError(422, 'OWNER_REQUIRED', '频道无 owner，无法读取共享区图谱')
    scopeKinds = ['global']
    scopeKeys = [ownerUserId]
    ownerFilter = ownerUserId
  }
  else if (scope === 'line') {
    if (!lineId) throw new AppError(422, 'LINE_REQUIRED', '频道未绑定产线')
    scopeKinds = ['line']
    scopeKeys = [lineId]
  }
  else if (scope === 'product') {
    const productId = String(q.productId ?? q.scopeKey ?? '').trim()
    if (!productId) throw new AppError(422, 'PRODUCT_REQUIRED', 'scope=product 需要 productId')
    const bound = db.prepare('SELECT 1 AS ok FROM channel_product_bindings WHERE channel_id = ? AND product_id = ? LIMIT 1')
      .get(channelId, productId)
    if (!bound) throw new AppError(422, 'PRODUCT_INVALID', 'product 作用域必须是本频道已绑定的产品')
    scopeKinds = ['product']
    scopeKeys = [productId]
  }
  return service.subgraph(channelId, {
    q: String(q.q ?? '').trim() || undefined,
    entity: String(q.entity ?? '').trim() || undefined,
    depth: Number(q.depth ?? 2),
    asOf: String(q.asOf ?? '').trim() || null,
    types: list(q.types),
    relations: list(q.relations),
    statuses: list(q.statuses),
    limit: Number(q.limit ?? 200),
    scopeKinds: scopeKinds as never,
    scopeKeys,
    ownerUserId: ownerFilter,
    includeEpisodes: String(q.includeEpisodes ?? '') === '1',
  })
})
