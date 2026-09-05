/**
 * PATCH /api/workshop/channels/:id —— 更新 channel(name/description/workspace/enabled)。
 * - channel 不存在 → 404 NOT_FOUND
 * - workspace 变更确保目录存在并卸载已装配成员(cwd 重载)
 * - enabled=0 停调度器并卸载全部成员
 */
import { z } from 'zod'
import { resolveUser } from '../../caller'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'

const channelLlmSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
}).optional()

const patchChannelSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  scenarioPrompt: z.string().optional(),
  workspace: z.string().min(1).optional(),
  enabled: z.number().int().min(0).max(1).optional(),
  /** channel 级默认 LLM(不传 = 不变;null = 清除回引擎默认) */
  llm: channelLlmSchema.nullable(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(patchChannelSchema))
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  return manager.updateChannel(channelId, body)
})
