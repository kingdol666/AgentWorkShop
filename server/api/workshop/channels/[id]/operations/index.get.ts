/**
 * GET /api/workshop/channels/:id/operations —— 操作与数采全量追溯（批次 N3，只读）。
 *
 * 过滤：line/product/recipe/recipeRevision/run/node/from-to/actor/path/verdict/hasDaq/
 * attempt/proposal；返回设定+上下文+DAQ 前后值+判定+拒绝/未知尝试+覆盖率。
 * 权限：频道 owner/admin（用户 token）；Agent token 仅本频道且产线过滤必须等于频道绑定。
 */
import { getQuery, getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCallerOrNull, resolveUser } from '../../../caller'
import { queryOperationProvenance } from '../../../../../services/workshop/aml/provenance-query'

/** 浏览器会话（cookie）或 Bearer 用户/Agent token 均可；未知 → 401 */
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
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读操作追溯')
  }
  else {
    manager.requireOwned(channel.ownerUserId, who.user.id, 'channel')
  }

  const q = getQuery(event)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const lineId = str(q.line_id) ?? str(q.lineId)
  if (who.kind === 'agent' && lineId && channel.lineId && lineId !== channel.lineId) {
    throw new AppError(403, 'SCOPE_VIOLATION', '产线不在本频道绑定范围')
  }
  const hasDaqRaw = str(q.has_daq) ?? str(q.hasDaq)
  const page = queryOperationProvenance(manager.deps.db, {
    lineId: lineId,
    productId: str(q.product_id) ?? str(q.productId),
    recipeId: str(q.recipe_id) ?? str(q.recipeId),
    recipeRevision: str(q.recipe_revision) ?? str(q.recipeRevision),
    runId: str(q.run_id) ?? str(q.runId),
    nodeId: str(q.node_id) ?? str(q.nodeId),
    fromIso: str(q.from),
    toIso: str(q.to),
    actor: str(q.actor),
    path: str(q.path),
    verdict: str(q.verdict),
    hasDaq: hasDaqRaw === undefined ? undefined : (hasDaqRaw === 'true' || hasDaqRaw === '1'),
    attemptId: str(q.attempt_id) ?? str(q.attemptId),
    proposalId: str(q.proposal_id) ?? str(q.proposalId),
    limit: num(q.limit),
    beforeTs: str(q.before_ts) ?? str(q.beforeTs),
    beforeId: str(q.before_id) ?? str(q.beforeId),
  })
  return page
})
