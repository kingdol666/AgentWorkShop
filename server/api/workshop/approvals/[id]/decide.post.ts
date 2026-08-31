/**
 * POST /api/workshop/approvals/:id/decide —— 复核裁决(R3 maker-checker 的 checker 一步)。
 * 仅 admin;硬校验申请人≠批核人;裁决后申请人携 approvalId 重放原高危请求放行。
 * body: { approved: boolean, comment?: string }
 */
import { readBody, getRouterParam } from 'h3'
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getOps, audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ approved?: boolean, comment?: string }>(event) ?? {}
  const repo = getOps()?.approvalRequests
  if (!repo) throw new AppError(503, 'UNAVAILABLE', '复核持久化未就绪')
  const req = repo.get(id)
  if (!req) throw new AppError(404, 'NOT_FOUND', '复核记录不存在')
  if (req.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', '该复核已裁决')
  // maker-checker 硬校验:申请人不能自审自批
  if (req.requestedBy === user.id) {
    throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '申请人不能批核自己的请求(双人复核)')
  }
  const approved = body.approved !== false
  const decided = repo.decide(id, approved, user.id, user.name, String(body.comment ?? ''), new Date().toISOString())
  // R1:复核裁决留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: approved ? 'approval.approve' : 'approval.deny', targetKind: 'approval-request', targetId: id, detail: { action: req.action, targetId: req.targetId, requestedBy: req.requestedName, comment: String(body.comment ?? '') } })
  return { request: decided }
})
