/**
 * POST /api/workshop/channels/:id/agents/:agentId/memories/search —— 记忆混合检索(客户端观察面)。
 * - 与 agent 运行时 search_memory 工具同源算法(FTS+向量融合,0.5×相关性+0.3×时近性+0.2×重要性排序)
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - scope: auto=目标 agent 私有域+Channel 公共域(默认,sessionId 命中加分) / private / shared / session=仅当前会话作用域行
 * - 返回结构化片段(content 未切分原文;source 标注 private/shared)
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../../../utils/validate'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveAgentOrUser } from '../../../../../caller'

const searchSchema = z.object({
  query: z.string().min(1, 'query 必填'),
  scope: z.enum(['auto', 'private', 'shared', 'session']).optional(),
  /** session/session 档过滤:目标 agent 记忆中的会话作用域 */
  sessionId: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  // 双域鉴权:Agent 成员 token(作业面)或用户 token(控制台 owner)
  const who = resolveAgentOrUser(event)
  const manager = getWorkshopManager()
  let byOwner = false
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可检索记忆')
  }
  else {
    const ch = manager.getChannelForUser(channelId, who.user.id)
    manager.requireOwned(ch.ownerUserId, who.user.id, 'channel')
    byOwner = true
  }
  const body = await readValidatedBody(event, zValidator(searchSchema))
  if (body.scope === 'session') {
    if (!body.sessionId) throw new AppError(400, 'SESSION_REQUIRED', 'scope=session 需要 sessionId')
    const session = manager.listChannelSessions(channelId).find(s => s.id === body.sessionId && s.status === 'active' && s.instanceKind !== 'project')
    if (!session) throw new AppError(403, 'SESSION_SCOPE_FORBIDDEN', 'sessionId 不属于当前 Channel 的活动会话')
    const memberMap = JSON.parse(session.memberMapJson || '{}') as Record<string, string>
    const caller = who.kind === 'agent' ? who.caller.id : agentId
    if (!Object.values(memberMap).includes(caller)) throw new AppError(403, 'SESSION_SCOPE_FORBIDDEN', 'sessionId 不属于当前 Agent')
  }
  return manager.searchAgentMemories(channelId, who.kind === 'agent' && !byOwner ? who.caller.id : agentId, agentId, {
    query: body.query,
    scope: body.scope,
    sessionId: body.sessionId ?? null,
    limit: body.limit,
  }, { byOwner })
})
