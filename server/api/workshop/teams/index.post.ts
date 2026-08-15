/**
 * POST /api/workshop/teams —— 创建 AgentTeam(Agent 模板编组容器)。
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const createTeamSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  description: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(createTeamSchema))
  return getWorkshopManager().createTeam({
    name: body.name,
    description: body.description,
  })
})
