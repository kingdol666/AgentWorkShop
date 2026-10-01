/**
 * POST /api/workshop/exp/confirmations/:id/decide —— 推断动作裁决(产线 Co-Pilot 确认队列)。
 * body: { ok: boolean } —— true=确认转正(推断转 episode status=pending 进入学习总结),
 * false=忽略(留档不总结)。鉴权 mirror dcw 写路由(server/api/workshop/dcw/[id]/write.post.ts):
 * resolveUser + requireLineMode(operate) —— 产线可写者方可确认(计划 §5.1)。
 * 404=卡片不存在;400=body 非法;409=已裁决;403=无产线操控权。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { audit } from '@/server/services/workshop/ops/ops'
import { getExpStateRepo } from '@/server/services/workshop/exp/exp-state.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ ok?: boolean }>(event) ?? {}
  if (typeof body.ok !== 'boolean') {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'body.ok 必填且为 boolean:true=确认转正,false=忽略')
  }
  const repo = getExpStateRepo()
  const card = repo.listConfirmations().find(c => c.id === id)
  if (!card) throw new AppError(404, ErrorCodes.NOT_FOUND, `确认卡不存在: ${id}`)
  // 产线可写者可确认(与 dcw 写控同一 requireLineMode 口径;readonly/none → 403)
  requireLineMode(user, card.lineId, 'operate')
  if (card.status !== 'pending') {
    throw new AppError(409, 'ALREADY_DECIDED', `该确认卡已裁决(${card.status} by ${card.decidedBy || '—'})`)
  }
  const decided = repo.decideConfirmation(id, body.ok, user.id)
  // R1 留痕:确认队列裁决是人工校验闭环的证据面(HITL 通过率用于经验置信降权)
  audit({
    actor: user.id, actorName: user.name, actorKind: 'user',
    action: body.ok ? 'exp.confirmation.confirm' : 'exp.confirmation.ignore',
    targetKind: 'exp-confirmation', targetId: id, lineId: card.lineId,
    summary: `推断动作裁决「${card.nodeName}」${card.from ?? '?'}→${card.to}:${body.ok ? '确认转正(进入经验总结)' : '忽略'}`,
    detail: { evidence: card.evidence, decidedBy: user.id, nodeId: card.nodeId },
  })
  return { confirmation: decided?.confirmation, episode: decided?.episode }
})
