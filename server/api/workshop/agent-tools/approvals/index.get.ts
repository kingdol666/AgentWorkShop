/**
 * GET /api/workshop/agent-tools/approvals?agentId=&scope=pending|history
 * —— 手动确认模式的执行审批列表(孪生侧栏审批面板轮询)。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getToolApprovals } from '@/server/services/workshop/agents/tool-approvals'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const agentId = typeof q.agentId === 'string' ? q.agentId : ''
  const scope = q.scope === 'history' ? 'history' : 'pending'
  return {
    approvals: scope === 'history' ? getToolApprovals().historyList() : getToolApprovals().listPending(agentId),
  }
})
