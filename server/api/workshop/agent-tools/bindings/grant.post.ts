/**
 * POST /api/workshop/agent-tools/bindings/grant —— lead 把自己绑定的节点授权给同频道 worker。
 * body: { channelId, agentId(worker 成员实例), nodeIds: string[], mode?: 'auto'|'manual' }
 * 硬约束:nodeIds 每一个都必须在频道 lead 的绑定面内(权限不可超越授予者);全成全败。
 * 产线权限随绑定继承(lead 绑定建立时已校验);绑定带 grantedByAgentId/grantedAt 溯源。
 * 鉴权:channel 归属者(遗留公共 channel 需 admin)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { applyDelegation, planDelegation } from '@/server/services/workshop/agents/node-delegation'
import type { DelegationMember } from '@/server/services/workshop/agents/node-delegation'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ channelId?: string, agentId?: string, nodeIds?: string[], mode?: 'auto' | 'manual' }>(event) ?? {}
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
  const plan = planDelegation({
    leaderAgentId: row.leadAgentId,
    channelId,
    targetAgentId: agentId,
    nodeIds,
    members,
    mode: body.mode,
  })
  const bindings = applyDelegation(plan, row.leadAgentId)
  return { granted: bindings }
})
