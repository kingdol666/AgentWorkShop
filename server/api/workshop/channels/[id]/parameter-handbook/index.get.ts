/**
 * GET /api/workshop/channels/:id/parameter-handbook —— 参数经验手册（批次 M，确定性模板）。
 * 只汇总结构化主张；返回 markdown + 来源数 + 主张数。只读、不写配方。
 */
import { getQuery, getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCallerOrNull, resolveUser } from '../../../caller'
import { buildParameterHandbook } from '../../../../../services/workshop/experience/claims'

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
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读参数手册')
  }
  else {
    manager.requireOwned(channel.ownerUserId, who.user.id, 'channel')
  }
  const q = getQuery(event)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const lineId = str(q.line_id) ?? str(q.lineId) ?? channel.lineId ?? undefined
  return buildParameterHandbook(manager.deps.db, {
    lineId,
    productId: str(q.product_id) ?? str(q.productId),
    nodeId: str(q.node_id) ?? str(q.nodeId),
    recipeRevision: str(q.recipe_revision) ?? str(q.recipeRevision),
    // 与 /parameter-experience 同一作用域口径（fail-closed）：未绑定产线时也不能
    // 退化成"全库汇总"，否则手册会把别的 owner 的经验拼进来。
    scopeChannelIds: [channelId],
    scopeLineIds: manager.deps.repos.memories.contextFor(channelId).lineIds,
    scopeProductIds: manager.deps.repos.memories.contextFor(channelId).productIds,
  })
})
