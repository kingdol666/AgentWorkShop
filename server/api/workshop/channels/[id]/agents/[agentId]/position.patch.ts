/**
 * PATCH /api/workshop/channels/:id/agents/:agentId/position —— 管理员布局:保存 Agent 落点。
 * - Bearer 用户 token;body: { x, z }(3D 小镇世界坐标;缺省清除)
 * - 与既有 config 合并(homeX/homeZ),不覆盖 modelRef 等既有字段;
 * - 经既有 updateChannelAgent 持久化并 AEP agent.member(op=updated) 回流前端(town 重建即按新 home 落位)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readBody<{ x?: number, z?: number }>(event)
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const members = await manager.listChannelAgents(channelId)
  const agent = members.find(a => a.id === agentId)
  if (!agent) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)

  // 合并写入,保留 modelRef 等既有 config;x/z 缺省/非有限 → 清除对应 home
  const config = { ...(agent.config ?? {}) }
  if (typeof body?.x === 'number' && Number.isFinite(body.x)) config.homeX = Math.round(body.x * 10) / 10
  else delete config.homeX
  if (typeof body?.z === 'number' && Number.isFinite(body.z)) config.homeZ = Math.round(body.z * 10) / 10
  else delete config.homeZ
  await manager.updateChannelAgent(agentId, { config }, { channelId, by: 'user', reason: 'position' })
  return { agentId, name: agent.name, config }
})
