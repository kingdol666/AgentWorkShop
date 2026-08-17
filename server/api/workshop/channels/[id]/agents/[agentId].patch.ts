/**
 * PATCH /api/workshop/channels/:id/agents/:agentId —— 更新 channel 成员实例(name/config/enabled)。
 * 变更后运行时卸载,下次任务按新配置重载;成功经 AEP agent.member(op=updated) 事件广播。
 * - channel/成员不存在 → 404 NOT_FOUND;非属主 → 403
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '../../../caller'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readBody<{ name?: string, config?: Record<string, unknown>, enabled?: number, reason?: string }>(event)
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const members = await manager.listChannelAgents(channelId)
  if (!members.some(a => a.id === agentId)) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
  const patch: { name?: string, config?: Record<string, unknown>, enabled?: number } = {}
  if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (body?.config && typeof body.config === 'object') patch.config = body.config
  if (body?.enabled === 0 || body?.enabled === 1) patch.enabled = body.enabled
  const agent = await manager.updateChannelAgent(agentId, patch, { channelId, by: 'user', reason: body?.reason })
  return { agentId: agent.id, name: agent.name, harness: agent.harness, role: agent.role }
})
