/**
 * POST /api/workshop/teams —— 创建 AgentTeam(Agent 模板编组容器)。
 * visibility 缺省 private;public = 全员可读可用,仅属主/admin 可改删。
 */
import { z } from 'zod'
import { resolveUser } from '../caller'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const createTeamSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  description: z.string().optional(),
  visibility: z.enum(['private', 'public']).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(createTeamSchema))
  return getWorkshopManager().createTeam({
    name: body.name,
    description: body.description,
    visibility: body.visibility,
    ownerUserId: user.id,
  })
})
