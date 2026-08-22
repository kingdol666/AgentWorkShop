/**
 * POST /api/workshop/channels/:id/memories —— 写/更新团队共享记忆(lead 策展)。
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - 仅 lead 可写(manager 校验 → 403 SCOPE_VIOLATION);稳定 dedupKey 幂等刷新
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveAgentOrUser } from '../../../caller'

const teamMemorySchema = z.object({
  title: z.string().min(1, 'title 必填'),
  content: z.string().min(1, 'content 必填'),
  importance: z.number().min(0).max(1).optional(),
  dedupKey: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  // 双域鉴权:Agent 成员 token(作业面)或用户 token(控制台 owner)
  const who = resolveAgentOrUser(event)
  const manager = getWorkshopManager()
  let byOwner = false
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可写团队记忆')
  }
  else {
    const ch = manager.getChannelForUser(channelId, who.user.id)
    manager.requireOwned(ch.ownerUserId, who.user.id, 'channel')
    byOwner = true
  }
  const body = await readValidatedBody(event, zValidator(teamMemorySchema))
  return manager.addTeamMemory(channelId, who.kind === 'agent' && !byOwner ? who.caller.id : '__team__', {
    title: body.title,
    content: body.content,
    importance: body.importance,
    dedupKey: body.dedupKey,
  }, { byOwner })
})
