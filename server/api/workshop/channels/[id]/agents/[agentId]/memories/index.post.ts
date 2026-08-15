/**
 * POST /api/workshop/channels/:id/agents/:agentId/memories —— 写/更新 Agent 私有记忆(agent 本人或 lead 策展)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 仅本人或 lead 可写(manager 校验 → 403 SCOPE_VIOLATION);稳定 dedupKey 幂等刷新
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../../../utils/validate'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveCaller } from '../../../../../caller'

const agentMemorySchema = z.object({
  title: z.string().min(1, 'title 必填'),
  content: z.string().min(1, 'content 必填'),
  importance: z.number().min(0).max(1).optional(),
  dedupKey: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readValidatedBody(event, zValidator(agentMemorySchema))
  const caller = resolveCaller(event)
  if (caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可策展 Agent 记忆')
  getWorkshopManager().addAgentMemory(channelId, caller.id, agentId, {
    title: body.title,
    content: body.content,
    importance: body.importance,
    dedupKey: body.dedupKey,
  })
  return { ok: true, agentId }
})
