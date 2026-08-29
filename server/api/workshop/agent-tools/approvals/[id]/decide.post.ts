/**
 * POST /api/workshop/agent-tools/approvals/:id/decide —— 批准/拒绝一次工具执行。
 * body: { approved: boolean, comment?: string }(备注随 tool result 返回给 Agent)
 */
import { readBody, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ approved?: boolean, comment?: string }>(event) ?? {}
  const approval = getToolApprovals().decide(id, body.approved !== false, String(body.comment ?? ''))
  return { approval }
})
