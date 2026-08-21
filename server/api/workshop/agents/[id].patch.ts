/**
 * PATCH /api/workshop/agents/:id —— 更新 agent(name/harness/config/enabled/visibility)。
 * 权限:属主或 admin;内置模板(owner NULL)任何人不可修改(TEMPLATE_BUILTIN)。
 */
import { z } from 'zod'
import { resolveUser } from '../caller'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { AppError } from '../../../utils/errors'
import { getWorkshopManager } from '../../../plugins/workshop'

const patchAgentSchema = z.object({
  name: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.number().int().min(0).max(1).optional(),
  visibility: z.enum(['private', 'public']).optional(),
})

export default defineApiHandler(async (event) => {
  const agentId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(patchAgentSchema))
  const manager = getWorkshopManager()
  const agent = manager.getAgent(agentId)
  if (!agent) throw new AppError(404, 'NOT_FOUND', `Agent 不存在: ${agentId}`)
  manager.requireWritable(agent.ownerUserId, user, 'Agent 模板')
  return manager.updateAgent(agentId, body)
})
