/**
 * POST /api/workshop/agents/subscribe —— caller 订阅同事产出(REST 作业面,与 MCP workshop.a2a.subscribe 同语义)。
 * - 需要 Bearer token;目标必须同 channel(manager 校验)
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveCaller } from '../caller'

const subscribeSchema = z.object({
  agentIds: z.array(z.string()).optional(),
})

export default defineApiHandler(async (event) => {
  const caller = resolveCaller(event)
  const body = await readValidatedBody(event, zValidator(subscribeSchema))
  await getWorkshopManager().subscribe(caller.channelId, caller.id, { agentIds: body.agentIds })
  return { subscribed: true, agentId: caller.id }
})
