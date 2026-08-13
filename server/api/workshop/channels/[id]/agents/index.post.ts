/**
 * POST /api/workshop/channels/:id/agents —— 创建 Agent(role=lead/worker)(设计文档 §6.2)。
 * - channel 不存在 → 404 NOT_FOUND
 * - 重复创建 lead → 409 LEAD_EXISTS(manager 校验)
 * - 创建 lead 后同步启动其 SchedulerLoop
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../../../../plugins/workshop'

const createAgentSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  harness: z.string().min(1, 'harness 必填'),
  role: z.enum(['lead', 'worker']),
  config: z.record(z.string(), z.unknown()).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(createAgentSchema))
  const manager = getWorkshopManager()
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
  const agent = await manager.createAgent({
    channelId,
    name: body.name,
    harness: body.harness,
    role: body.role,
    config: body.config,
  })
  if (agent.role === 'lead') {
    ensureLeadSchedulerLoop(manager, channelId)
  }
  return agent
})
