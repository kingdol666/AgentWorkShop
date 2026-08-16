/**
 * GET /api/workshop/channels/:id/messages —— channel 消息历史(倒序,limit 默认 50)。
 * - channel 不存在 → 404 NOT_FOUND
 */
import { z } from 'zod'
import { resolveUser } from '../../../caller'
import { getRouterParam, getQuery } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { defineApiHandler } from '../../../../../utils/response'
import { AppError } from '../../../../../utils/errors'
import { getWorkshopManager } from '../../../../../plugins/workshop'
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const query = await zValidator(querySchema)(getQuery(event))
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  manager.getChannelForUser(channelId, user.id)
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)

  // 经 manager 内部 repos 拉取消息历史(倒序 → 正序返回)
  const internal = manager as unknown as {
    deps: { repos: { messages: { listRecentByChannel(channelId: string, limit: number): Array<{
      id: string
      channelId: string
      taskId: string | null
      fromAgentId: string | null
      toAgentId: string | null
      role: string
      partsJson: string
      metadataJson: string
      state: string
      createdAt: string
      consumedAt: string | null
    }> } } }
  }
  const rows = internal.deps.repos.messages.listRecentByChannel(channelId, query.limit ?? 50)
  // 倒序返回最新在前(前端按需反转)
  return rows.map(row => ({
    id: row.id,
    channelId: row.channelId,
    taskId: row.taskId,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    role: row.role,
    parts: JSON.parse(row.partsJson),
    metadata: JSON.parse(row.metadataJson),
    state: row.state,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  }))
})
