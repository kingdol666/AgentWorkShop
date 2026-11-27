/** POST /api/workshop/channels/:id/memory-graph/runs —— 手动触发指定分区整理（后台执行）。 */
import { readValidatedBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { zValidator } from '@/server/utils/validate'
import { graphContext, graphRunSchema } from '@/server/utils/memory-graph-api'
import type { GraphPartitionSpec } from '@/server/services/workshop/memory/graph/types'

export default defineApiHandler(async (event) => {
  const { channelId, service, actor, ownerUserId, lineId, db } = graphContext(event, true)
  const body = await readValidatedBody(event, zValidator(graphRunSchema))
  let partition: GraphPartitionSpec = { scopeKind: 'channel', scopeKey: '' }
  if (body.scope === 'session') {
    const sessionId = body.sessionId ?? ''
    if (!sessionId) throw new AppError(422, 'SESSION_REQUIRED', 'scope=session 需要 sessionId')
    const session = db.prepare('SELECT id FROM channel_sessions WHERE id = ? AND channel_id = ?').get(sessionId, channelId)
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', '会话不存在或不属于该频道')
    partition = { scopeKind: 'session', scopeKey: sessionId }
  }
  else if (body.scope === 'shared') {
    if (!ownerUserId) throw new AppError(422, 'OWNER_REQUIRED', '频道无 owner，无法整理共享区')
    partition = { scopeKind: 'global', scopeKey: ownerUserId, ownerUserId }
  }
  else if (body.scope === 'line') {
    if (!lineId) throw new AppError(422, 'LINE_REQUIRED', '频道未绑定产线')
    partition = { scopeKind: 'line', scopeKey: lineId }
  }
  else if (body.scope === 'product') {
    if (!body.productId) throw new AppError(422, 'PRODUCT_REQUIRED', 'scope=product 需要 productId')
    const bound = db.prepare('SELECT 1 AS ok FROM channel_product_bindings WHERE channel_id = ? AND product_id = ? LIMIT 1')
      .get(channelId, body.productId)
    if (!bound) throw new AppError(422, 'PRODUCT_INVALID', 'product 作用域必须是本频道已绑定的产品')
    partition = { scopeKind: 'product', scopeKey: body.productId }
  }
  return service.startRun(channelId, body.mode, actor, partition)
})
