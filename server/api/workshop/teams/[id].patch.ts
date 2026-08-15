/**
 * PATCH /api/workshop/teams/:id —— 更新 AgentTeam(name/description)。
 * - 不存在 → 404 NOT_FOUND
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const patchTeamSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const teamId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(patchTeamSchema))
  return getWorkshopManager().updateTeam(teamId, {
    name: body.name,
    description: body.description,
  })
})
