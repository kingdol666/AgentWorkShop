/**
 * POST /api/workshop/teams/:id/deploy —— 把 AgentTeam 批量部署到 channel。
 * - body.channelId 必填;对每个成员模板克隆出独立身份 id 的新实例(同 addAgentToChannel)
 * - team 无成员 → 400 TEAM_EMPTY
 * - channel 已有 lead 且 team 成员含 lead → 409 LEAD_EXISTS(先前克隆的实例保留,调用方可删后重试)
 * - 部署含 lead 的 team 后自动启动该 channel 的 SchedulerLoop(与单独放置 lead 同路径)
 */
import { z } from 'zod'
import { resolveUser } from '../../caller'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../plugins/workshop'

const deploySchema = z.object({
  channelId: z.string().min(1, 'channelId 必填'),
})

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(deploySchema))
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const team = manager.getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  // 部署 = 克隆成员模板到本人 channel(不修改编组本身):公共编组(NULL owner)允许任何人使用;
  // 私有编组仅属主可用(他人可见模板但无权批量部署)
  if (team.ownerUserId !== null && team.ownerUserId !== user.id) {
    throw new AppError(403, 'SCOPE_VIOLATION', 'AgentTeam 不属于当前用户')
  }
  const ch = manager.getChannelForUser(body.channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  // 部署后:若 channel 尚无调度循环(新 lead 就位)→ 启动
  const result = await manager.deployTeamToChannel({ teamId, channelId: body.channelId })
  ensureLeadSchedulerLoop(manager, body.channelId)
  return result
})
