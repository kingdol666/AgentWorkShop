/**
 * GET /api/workshop/channels/:id/parameter-proposals —— 建议列表（批次 M2，只读）。
 */
import { getQuery, getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCallerOrNull, resolveUser } from '../../../caller'

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
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读参数建议')
  }
  else {
    manager.requireOwned(channel.ownerUserId, who.user.id, 'channel')
  }
  const q = getQuery(event)
  const where: string[] = ['channel_id = ?']
  const args: Array<string | number> = [channelId]
  if (typeof q.status === 'string' && q.status) {
    where.push('status = ?')
    args.push(q.status)
  }
  const rows = manager.deps.db.prepare(
    `SELECT id, line_id AS lineId, product_id AS productId, recipe_id AS recipeId, recipe_revision AS recipeRevision,
            node_id AS nodeId, node_name AS nodeName, variable, from_value AS fromValue, to_value AS toValue,
            expected_effect AS expectedEffect, ci_low AS ciLow, ci_high AS ciHigh, target_direction AS targetDirection,
            confidence, mode, evidence_json AS evidenceJson, status, applied_recipe_revision AS appliedRecipeRevision,
            feedback_json AS feedbackJson, created_at AS createdAt
       FROM parameter_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).all(...args, Math.min(500, Math.max(1, Number(q.limit ?? 50)))) as Array<Record<string, unknown>>
  return {
    items: rows.map(r => ({
      ...r,
      evidence: JSON.parse(String(r.evidenceJson ?? '[]')),
      feedback: JSON.parse(String(r.feedbackJson ?? '{}')),
      confidence: Number(r.confidence ?? 0),
    })),
  }
})
