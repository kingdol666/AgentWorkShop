/**
 * PATCH /api/workshop/teams/:id —— 更新 AgentTeam(name/description/visibility)。
 * 权限:属主或 admin;内置编组任何人不可修改。(修复:原无认证与归属校验)
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

const patchTeamSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).optional(),
})

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(patchTeamSchema))
  const manager = getWorkshopManager()
  const team = manager.getTeam(teamId)
  if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
  manager.requireWritable(team.ownerUserId, user, 'AgentTeam')
  return manager.updateTeam(teamId, {
    name: body.name,
    description: body.description,
    visibility: body.visibility,
  })
})
