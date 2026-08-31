/**
 * POST /api/workshop/agent-tools/approvals/:id/decide —— 批准/拒绝一次工具执行。
 * body: { approved: boolean, comment?: string }(备注随 tool result 返回给 Agent)
 */
import { readBody, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'
import { audit } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ approved?: boolean, comment?: string }>(event) ?? {}
  // S4:裁决人留痕(谁批准/拒绝了这次 HITL 下发)
  const approved = body.approved !== false
  const approval = getToolApprovals().decide(id, approved, String(body.comment ?? ''), user.id, user.name)
  // R1:HITL 裁决审计(闭环中的人为决策留痕)
  audit({ actor: user.id, actorName: user.name, actorKind: 'user', action: approved ? 'approval.approve' : 'approval.reject', targetKind: 'tool-approval', targetId: id, detail: { comment: String(body.comment ?? '') } })
  return { approval }
})
