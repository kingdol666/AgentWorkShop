/**
 * POST /api/workshop/approvals/:id/decide —— 复核裁决(R3 maker-checker 的 checker 一步)。
 * 仅 admin;硬校验申请人≠批核人;裁决后申请人携 approvalId 重放原高危请求放行。
 * body: { approved: boolean, comment?: string }
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { zValidator } from '@/server/utils/validate'
import { getOps, audit } from '@/server/services/workshop/ops/ops'

// 裁决是 maker-checker 的 checker 一步,保护的是高危写放行(配方整批下发/节点删除/
// 控制网关/回滚)。approved 必须显式布尔:旧实现 `body.approved !== false` 会把
// {} / {"approved":"false"} / {"approved":0} 全部判成批准(fail-open)——
// 同仓 agent-tools/approvals/[id]/decide.post.ts 的 v17 修复即为此类事故。
const schema = z.object({
  approved: z.boolean({
    invalid_type_error: 'approved 必须是显式布尔值(true=批准 / false=拒绝);缺省不再默认为批准',
  }),
  comment: z.string().max(2000, 'comment 超过 2000 字符上限').optional(),
})

export default defineApiHandler(async (event) => {
  const user = requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(schema))
  const repo = getOps()?.approvalRequests
  if (!repo) throw new AppError(503, 'UNAVAILABLE', '复核持久化未就绪')
  const req = repo.get(id)
  if (!req) throw new AppError(404, 'NOT_FOUND', '复核记录不存在')
  if (req.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', '该复核已裁决')
  // maker-checker 硬校验:申请人不能自审自批
  if (req.requestedBy === user.id) {
    throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '申请人不能批核自己的请求(双人复核)')
  }
  const approved = body.approved
  const decided = repo.decide(id, approved, user.id, user.name, String(body.comment ?? ''), new Date().toISOString())
  // 并发裁决:decide 是条件 UPDATE(status='pending'),输的一方 changes=0 返回 null。
  // 必须判空再留痕,否则会记下一条实际未发生的裁决。
  if (!decided) throw new AppError(409, 'ALREADY_DECIDED', '该复核已被其他管理员裁决')
  // R1:复核裁决留痕
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: approved ? 'approval.approve' : 'approval.deny', targetKind: 'approval-request', targetId: id, detail: { action: req.action, targetId: req.targetId, requestedBy: req.requestedName, comment: String(body.comment ?? '') } })
  return { request: decided }
})
