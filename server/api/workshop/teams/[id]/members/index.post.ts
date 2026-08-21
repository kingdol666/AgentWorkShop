/**
 * POST /api/workshop/teams/:id/members —— 把 Agent 模板加入 AgentTeam。
 * - agentId 必填(全局 Agent 模板 id)
 * - role 缺省 worker;team 内至多一个 lead(已有 → 409 LEAD_EXISTS)
 * - 重复加入 → 409 ALREADY_MEMBER
 */
import { z } from 'zod'
import { resolveUser } from '../../../caller'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'

const addMemberSchema = z.object({
  agentId: z.string().min(1, 'agentId 必填'),
  role: z.enum(['lead', 'worker']).optional(),
})

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(addMemberSchema))
  const manager = getWorkshopManager()
  const team = manager.getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  manager.requireWritable(team.ownerUserId, user, 'AgentTeam')
  return manager.addTemplateToTeam({
    teamId,
    templateId: body.agentId,
    role: body.role,
  })
})
