/**
 * POST /api/workshop/agent-tools/bindings/revoke —— lead 收回授予给 worker 的节点授权。
 * body: { channelId, agentId(worker 成员实例), nodeIds: string[] }
 * 可收回:lead 自己授予的(grantedByAgentId=lead)或 lead 也持有的节点绑定;
 * 其余绑定原样保留并在结果中标注 revoked=false。
 * 鉴权:channel 归属者(遗留公共 channel 需 admin)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { revokeDelegation } from '@/server/services/workshop/agents/node-delegation'
import type { DelegationMember } from '@/server/services/workshop/agents/node-delegation'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ channelId?: string, agentId?: string, nodeIds?: string[] }>(event) ?? {}
  const channelId = String(body.channelId ?? '')
  const agentId = String(body.agentId ?? '')
  const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.map(x => String(x ?? '').trim()).filter(Boolean) : []
  if (!channelId || !agentId || !nodeIds.length) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'channelId / agentId / nodeIds 必填')
  }
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  if (channel?.ownerUserId === null) {
    const { requireAdmin } = await import('@/server/api/workshop/caller')
    requireAdmin(event)
  }
  const row = (await manager.listChannels()).find(c => c.id === channelId)
  if (!row?.leadAgentId) throw new AppError(404, ErrorCodes.NOT_FOUND, `频道不存在或没有 lead: ${channelId}`)

  const members = await manager.listChannelAgents(channelId) as unknown as DelegationMember[]
  const results = revokeDelegation({
    leaderAgentId: row.leadAgentId,
    targetAgentId: agentId,
    nodeIds,
    members,
  })
  return { results }
})
