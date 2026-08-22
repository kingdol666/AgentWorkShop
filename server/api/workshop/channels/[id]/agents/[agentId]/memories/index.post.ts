/**
 * POST /api/workshop/channels/:id/agents/:agentId/memories —— 写/更新 Agent 记忆(agent 本人或 lead 策展)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 仅本人或 lead 可写私有域(manager 校验 → 403 SCOPE_VIOLATION);稳定 dedupKey 幂等刷新
 * - scope='shared'(可选):落 Channel 公共记忆域(agent:<caller>:<key> 命名空间,全员可检索)
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../../../utils/validate'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveAgentOrUser } from '../../../../../caller'

const agentMemorySchema = z.object({
  title: z.string().min(1, 'title 必填'),
  content: z.string().min(1, 'content 必填'),
  importance: z.number().min(0).max(1).optional(),
  dedupKey: z.string().optional(),
  scope: z.enum(['private', 'shared']).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  // 双域鉴权:Agent 成员 token(作业面)或用户 token(控制台 owner)
  const who = resolveAgentOrUser(event)
  const manager = getWorkshopManager()
  let byOwner = false
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可策展 Agent 记忆')
  }
  else {
    const ch = manager.getChannelForUser(channelId, who.user.id)
    manager.requireOwned(ch.ownerUserId, who.user.id, 'channel')
    byOwner = true
  }
  const body = await readValidatedBody(event, zValidator(agentMemorySchema))
  // owner 策展:curator 身份取目标成员(命名空间一致;byOwner 已旁路成员校验)
  manager.addAgentMemory(channelId, who.kind === 'agent' && !byOwner ? who.caller.id : agentId, agentId, {
    title: body.title,
    content: body.content,
    importance: body.importance,
    dedupKey: body.dedupKey,
    scope: body.scope,
  }, { byOwner })
  return { ok: true, agentId, scope: body.scope ?? 'private' }
})
