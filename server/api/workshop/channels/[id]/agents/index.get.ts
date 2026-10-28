/**
 * GET /api/workshop/channels/:id/agents —— channel 成员列表。
 * 双轨鉴权:用户 token(owner/遗留公共可见)或 agent token(本 channel 成员)。
 * - channel 不存在 → 404 NOT_FOUND
 *
 * 2026-10-28 安全修复:响应不再回显 agent token(worker 借此冒充 lead);
 * config 仅属主/admin 可见,且由 DTO 剔除启动类敏感键。
 */
import { getRouterParam } from 'h3'
import { resolveUser, resolveCallerOrNull } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { AppError } from '../../../../../utils/errors'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { channelAgentSummaries } from '../../../../../services/workshop/agents/agent-dto'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  // 双轨:优先按用户 token;无用户 token 时接受本 channel 成员的 agent token
  let user: { id: string, role: string } | null = null
  try {
    user = resolveUser(event)
    manager.getChannelForUser(channelId, user.id)
  }
  catch (err) {
    const caller = resolveCallerOrNull(event)
    if (!caller || caller.channelId !== channelId) throw err
  }
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
  const includeConfig = Boolean(user && (user.role === 'admin' || channel.ownerUserId === user.id))
  return channelAgentSummaries(await manager.listChannelAgents(channelId), { includeConfig })
})
