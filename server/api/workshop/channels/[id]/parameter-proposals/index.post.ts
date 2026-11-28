/**
 * GET  /api/workshop/channels/:id/parameter-proposals —— 建议列表（批次 M2，只读）。
 * POST /api/workshop/channels/:id/parameter-proposals —— 生成建议（落 proposed，绝不下发）。
 */
import { getQuery, getRouterParam, readBody } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveCallerOrNull, resolveUser } from '../../../caller'
import { proposeParameterAdjustment } from '../../../../../services/workshop/experience/parameter-proposal'

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
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读/生成参数建议')
  }
  else {
    manager.requireOwned(channel.ownerUserId, who.user.id, 'channel')
  }
  const db = manager.deps.db
  if ((event.method?.toUpperCase() ?? 'GET') === 'GET') {
    const q = getQuery(event)
    const where: string[] = ['channel_id = ?']
    const args: Array<string | number> = [channelId]
    if (typeof q.status === 'string' && q.status) {
      where.push('status = ?')
      args.push(q.status)
    }
    const requestedLimit = Number(q.limit ?? 50)
    const rows = db.prepare(
      `SELECT id, line_id AS lineId, product_id AS productId, recipe_id AS recipeId, recipe_revision AS recipeRevision,
              node_id AS nodeId, node_name AS nodeName, variable, from_value AS fromValue, to_value AS toValue,
              expected_effect AS expectedEffect, ci_low AS ciLow, ci_high AS ciHigh, target_direction AS targetDirection,
              confidence, mode, evidence_json AS evidenceJson, status, applied_recipe_revision AS appliedRecipeRevision,
              feedback_json AS feedbackJson, created_at AS createdAt
         FROM parameter_proposals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...args, Math.min(500, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50))) as Array<Record<string, unknown>>
    return {
      items: rows.map(r => ({
        ...r,
        evidence: JSON.parse(String(r.evidenceJson ?? '[]')),
        feedback: JSON.parse(String(r.feedbackJson ?? '{}')),
        confidence: Number(r.confidence ?? 0),
      })),
    }
  }
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  // lineId 是 RLS 锚点，不允许客户端任意指定（评审发现 6）：只接受频道自身绑定的产线；
  // 显式传入其他值一律 403 —— 与工具侧 readableLines 闸、GET 侧 contextFor 同口径。
  const lineId = String(channel.lineId ?? '').trim()
  if (!lineId) throw new AppError(422, 'LINE_REQUIRED', '频道未绑定产线（lineId 只取频道绑定，不收客户端输入）')
  const requestedLine = String(body.lineId ?? '').trim()
  if (requestedLine && requestedLine !== lineId) {
    throw new AppError(403, 'SCOPE_VIOLATION', 'lineId 不在频道绑定范围（只能为本频道绑定产线生成建议）')
  }
  const currentValues: Record<string, number> = {}
  if (body.currentValues && typeof body.currentValues === 'object') {
    for (const [k, v] of Object.entries(body.currentValues as Record<string, unknown>)) {
      const n = Number(v)
      if (Number.isFinite(n)) currentValues[k] = n
    }
  }
  const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.map(String) : undefined
  const result = proposeParameterAdjustment(db, {
    channelId,
    lineId,
    productId: String(body.productId ?? '').trim() || undefined,
    recipeId: String(body.recipeId ?? '').trim() || undefined,
    recipeRevision: String(body.recipeRevision ?? '').trim() || undefined,
    nodeIds,
    currentValues,
    targetMetric: String(body.targetMetric ?? '').trim() || undefined,
    actor: who.kind === 'user' ? who.user.id : who.caller.id,
  })
  return result
})
