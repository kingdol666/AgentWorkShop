/**
 * POST /api/workshop/optimization/recommendations/:id/dispatch —— 申请下发优化器建议(SW5)。
 * D11 防伪:body 只接受 { note? };任何证据字段 → 422。卡由服务端落库回查构造,建卡即返回。
 */
import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { requireRole } from '@/server/api/workshop/caller'
import { createDispatchCard } from '@/server/services/workshop/optimization/dispatch.service'
import { AppError } from '@/server/utils/errors'

const FORBIDDEN_EVIDENCE_KEYS = ['coverage', 'coverageTest', 'qhat', 'qhatPerCv', 'inputDistance', 'crosscheck', 'rowHash', 'row_hash', 'devPerCv', 'maxDev', 'verdict', 'uq', 'predicted', 'replayed', 'artifactHash']

export default defineApiHandler(async (event) => {
  const user = requireRole(event, ['admin', 'editor'])
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>) ?? {}
  // D11:任何证据字段 → 422(payload 全部服务端落库回查)
  const smuggled = Object.keys(body).filter(k => FORBIDDEN_EVIDENCE_KEYS.includes(k))
  if (smuggled.length > 0) {
    throw new AppError(422, 'DISPATCH_BODY_EVIDENCE_FORBIDDEN',
      `body 不得携带证据字段(${smuggled.join(',')});payload 全部由服务端按 recommendation_id 落库回查构造`)
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : ''
  const card = await createDispatchCard(user, id, note)
  return {
    dispatch: {
      cardId: card.cardId,
      agentInstanceId: card.agentInstanceId,
      recipeId: card.recipeId,
      rowHashHint: '见审批卡 payload(服务端构造;卡面展示截断值供人回查)',
    },
  }
})
