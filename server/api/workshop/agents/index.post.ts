/**
 * POST /api/workshop/agents —— 创建全局 Agent 定义(与 channel 无关,可复用)。
 */
import { z } from 'zod'
import { resolveUser } from '../caller'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

const createAgentSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  harness: z.string().min(1, 'harness 必填'),
  config: z.record(z.string(), z.unknown()).optional(),
})

export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(createAgentSchema))
  const user = resolveUser(event)
  return getWorkshopManager().createAgent({
    name: body.name,
    harness: body.harness,
    config: body.config,
    ownerUserId: user.id,
  })
})
