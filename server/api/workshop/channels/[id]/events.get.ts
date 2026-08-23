/**
 * GET /api/workshop/channels/:id/events —— AEP 事件持久化历史(server 驱动)。
 * - Bearer 用户 token;channel 须为本人(或遗留公共只读)
 * - 查询:limit(默认 200,上限 1000)/ beforeSeq(向上翻页)
 *   / agentId(仅该 agent 的事件,lane 按需加载)
 *   / excludeTypes(逗号分隔,剔除过程帧如 agent.delta —— 历史回放由落定帧携带全文)
 * - 返回 AEP 信封同构帧(与 WS 增量无缝衔接;正序);total 与过滤条件同口径
 */
import { getRouterParam, getQuery } from 'h3'
import { z } from 'zod'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { resolveUser } from '../../caller'
import type { ChannelEventRepo } from '../../../../services/workshop/db/channel-event.repo'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  beforeSeq: z.coerce.number().int().min(0).optional(),
  agentId: z.string().min(1).optional(),
  excludeTypes: z.string().min(1).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)
  const q = await zValidator(querySchema)(getQuery(event))
  const repo: ChannelEventRepo = (manager as unknown as { deps: { repos: { channelEvents: ChannelEventRepo } } }).deps.repos.channelEvents
  const opts = {
    agentId: q.agentId,
    excludeTypes: q.excludeTypes?.split(',').map(s => s.trim()).filter(Boolean),
  }
  const before = q.beforeSeq
  const limit = q.limit ?? 200
  const items = before !== undefined && before > 0
    ? repo.listBefore(channelId, before, limit, opts)
    : repo.listRecent(channelId, limit, opts)
  return {
    channelId,
    total: repo.count(channelId, opts),
    maxSeq: repo.maxSeq(channelId),
    items: items.map((e: { seq: number, type: string, at: string, agentId: string | null, taskId: string | null, payload: unknown }) => ({
      v: 1,
      type: e.type,
      seq: e.seq,
      at: e.at,
      channelId,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.taskId ? { taskId: e.taskId } : {}),
      payload: e.payload,
    })),
  }
})
