/**
 * PATCH /api/workshop/agents/:id —— 更新 agent(name/harness/config/enabled)。
 * - agent 不存在 → 404 NOT_FOUND
 * - 变更后卸载已装配运行时,下次任务触发按新配置 spawn
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const patchAgentSchema = z.object({
  name: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.number().int().min(0).max(1).optional(),
})

export default defineApiHandler(async (event) => {
  const agentId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(patchAgentSchema))
  return getWorkshopManager().updateAgent(agentId, body)
})
