/**
 * PATCH /api/workshop/channels/:id/agents/:agentId —— 更新 channel 成员实例(name/harness/config/enabled)。
 * 变更后运行时卸载,下次任务按新配置重载;成功经 AEP agent.member(op=updated) 事件广播。
 * harness 变更在 manager 内做结构+Prefab dry-run，失败不落库。
 * - channel/成员不存在 → 404 NOT_FOUND;非属主 → 403
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '../../../caller'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { assertSpawnConfigAllowed } from '../../../../../services/workshop/agents/harness-spawn-policy'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readBody<{ name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number, reason?: string }>(event)
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const members = await manager.listChannelAgents(channelId)
  const member = members.find(a => a.id === agentId)
  if (!member) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
  const nextHarness = typeof body?.harness === 'string' && body.harness.trim() ? body.harness.trim() : member.harness
  if (body?.config || nextHarness !== member.harness) {
    // 启动面收权按目标 harness 判定，避免“先换 harness 再写被禁参数”的旁路。
    assertSpawnConfigAllowed(nextHarness, body?.config ?? member.config, user)
  }
  const patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number } = {}
  if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (nextHarness !== member.harness) patch.harness = nextHarness
  if (body?.config && typeof body.config === 'object') patch.config = body.config
  if (body?.enabled === 0 || body?.enabled === 1) patch.enabled = body.enabled
  const agent = await manager.updateChannelAgent(agentId, patch, { channelId, by: 'user', reason: body?.reason, actor: user })
  return { agentId: agent.id, name: agent.name, harness: agent.harness, role: agent.role }
})
