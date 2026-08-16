/**
 * POST /api/workshop/channels/:id/agents/:agentId/memories/search —— 记忆混合检索(客户端观察面)。
 * - 与 agent 运行时 search_memory 工具同源算法(FTS+向量融合,0.5×相关性+0.3×时近性+0.2×重要性排序)
 * - 需要 Bearer token;caller 须为本 channel 成员(跨 channel → 403 SCOPE_VIOLATION)
 * - scope: auto=目标 agent 私有域+Channel 公共域(默认) / private / shared
 * - 返回结构化片段(content 未切分原文;source 标注 private/shared)
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../../../utils/validate'
import { AppError } from '../../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../../plugins/workshop'
import { resolveCaller } from '../../../../../caller'

const searchSchema = z.object({
  query: z.string().min(1, 'query 必填'),
  scope: z.enum(['auto', 'private', 'shared']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readValidatedBody(event, zValidator(searchSchema))
  const caller = resolveCaller(event)
  if (caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可检索记忆')
  return getWorkshopManager().searchAgentMemories(channelId, caller.id, agentId, {
    query: body.query,
    scope: body.scope,
    limit: body.limit,
  })
})
