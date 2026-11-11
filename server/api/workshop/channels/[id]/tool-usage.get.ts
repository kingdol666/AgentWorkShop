/**
 * GET /api/workshop/channels/:id/tool-usage —— 频道工具用量聚合(Block 管线业务面)。
 *
 * 数据源:channel_events 中 type='agent.block'(由 ws 层发布:omp 原生块 + 其余引擎
 * 🔧 文本归一,harness 归因见 selectStatusFrame);聚合按 harness|tool|agent 分账。
 * 查询:limit(默认 500,上限 2000;倒序取最新段)/ sinceMs(窗口下界,epoch ms)。
 * 授权与 events.get 同面:getChannelForUser(本人或遗留公共只读)。
 */
import { getRouterParam, getQuery } from 'h3'
import { z } from 'zod'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { resolveUser } from '../../caller'
import { aggregateToolUsage } from '../../../../services/workshop/agents/tool-usage'
import type { ChannelEventRepo } from '../../../../services/workshop/db/channel-event.repo'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  sinceMs: z.coerce.number().int().positive().optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  manager.getChannelForUser(channelId, user.id)
  const q = await zValidator(querySchema)(getQuery(event))
  const repo: ChannelEventRepo = (manager as unknown as { deps: { repos: { channelEvents: ChannelEventRepo } } }).deps.repos.channelEvents
  const since = q.sinceMs !== undefined ? new Date(q.sinceMs).toISOString() : undefined
  const rows = repo.listByTypes(channelId, ['agent.block'], q.limit ?? 500, since)
  const summary = aggregateToolUsage(rows)
  return {
    channelId,
    window: { limit: q.limit ?? 500, sinceMs: q.sinceMs ?? null },
    ...summary,
  }
})
