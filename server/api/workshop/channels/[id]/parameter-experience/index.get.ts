/**
 * GET /api/workshop/channels/:id/parameter-experience —— 结构化参数经验（批次 M，只读）。
 * 过滤：line/product/node/variable/recipeRevision/verdict/deployedOnly/includeLegacy。
 */
import { getQuery, getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCallerOrNull, resolveUser } from '../../../caller'
import { queryParameterExperience } from '../../../../../services/workshop/experience/claims'

function principalOf(event: Parameters<typeof resolveUser>[0]) {
  try {
    return { kind: 'user' as const, user: resolveUser(event) }
  }
  catch {
    const caller = resolveCallerOrNull(event)
    if (caller) return { kind: 'agent' as const, caller }
    throw new AppError(401, 'UNAUTHORIZED', '需要有效的用户会话或 Bearer token')
  }
}

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const who = principalOf(event)
  const manager = getWorkshopManager()
  const channel = who.kind === 'user'
    ? manager.getChannelForUser(channelId, who.user.id)
    : manager.deps.repos.channels.findById(channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', '频道不存在')
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读参数经验')
  }
  else {
    manager.requireOwned(channel.ownerUserId, who.user.id, 'channel')
  }
  const q = getQuery(event)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const bool = (v: unknown): boolean => v === true || v === 'true' || v === '1'
  const lineId = str(q.line_id) ?? str(q.lineId)
  if (who.kind === 'agent' && lineId && channel.lineId && lineId !== channel.lineId) {
    throw new AppError(403, 'SCOPE_VIOLATION', '产线不在本频道绑定范围')
  }
  return {
    items: queryParameterExperience(manager.deps.db, {
      lineId: lineId,
      productId: str(q.product_id) ?? str(q.productId),
      nodeId: str(q.node_id) ?? str(q.nodeId),
      variable: str(q.variable),
      recipeRevision: str(q.recipe_revision) ?? str(q.recipeRevision),
      verdict: str(q.verdict),
      deployedOnly: bool(q.deployed_only ?? q.deployedOnly),
      includeLegacy: bool(q.include_legacy ?? q.includeLegacy),
      limit: Number(q.limit ?? 50),
    }),
  }
})
