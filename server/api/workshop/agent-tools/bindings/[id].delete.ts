/**
 * DELETE /api/workshop/agent-tools/bindings/:id —— 解除绑定。
 */
import { createError, getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getAgentNodeBindingRepo } from '@/server/services/workshop/agents/node-bindings.repo'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const repo = getAgentNodeBindingRepo()
  const all = repo.all()
  const binding = all.find(b => b.id === id)
  if (!binding) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  if (!repo.unbind(id)) throw createError({ statusCode: 404, statusMessage: 'binding not found' })
  // 解绑即失效:该 Agent 对该节点的挂起审批按拒绝收敛(tool result 注明原因)
  getToolApprovals().cancelPendingFor(binding.agentId, binding.nodeId)
  return { ok: true }
})
