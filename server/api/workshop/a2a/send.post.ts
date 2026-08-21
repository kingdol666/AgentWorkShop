/**
 * POST /api/workshop/a2a/send —— Agent 点对点发消息给同事(REST 作业面,与 MCP workshop.a2a.send 同语义)。
 * - 需要 Bearer token(caller 由 token 决定,不接受请求体自报)
 * - 跨 channel 目标 → 403 SCOPE_VIOLATION(manager 校验)
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import { resolveCaller } from '../caller'
import type { Part } from '../../../services/workshop/types/a2a'

const sendSchema = z.object({
  toAgentId: z.string().min(1, 'toAgentId 必填'),
  parts: z.array(z.unknown()).min(1, 'parts 至少 1 个') as z.ZodType<Part[]>,
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export default defineApiHandler(async (event) => {
  const caller = resolveCaller(event)
  const body = await readValidatedBody(event, zValidator(sendSchema))
  return getWorkshopManager().sendA2A(caller.channelId, caller.id, {
    toAgentId: body.toAgentId,
    parts: body.parts,
    metadata: body.metadata,
  })
})
