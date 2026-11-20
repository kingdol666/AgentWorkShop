/**
 * GET /api/workshop/channels/:id/memories/:memoryId/experience —— 经验治理只读投影(Task 7)。
 *
 * 返回精确版本、生命周期、部署状态、主张形成时间、Beta 祖先与审计动作序列,
 * 让运维/审阅者从一个「使用」追到证据。仅本 channel 成员或 owner 可读;
 * 不返回正文、候选计数或任何凭据。
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../../utils/errors'
import { defineApiHandler } from '../../../../../../utils/response'
import { getWorkshopManager } from '../../../../../../plugins/workshop'
import { getAmlRuntime } from '../../../../../../services/workshop/aml/runtime'
import { experiencePanelDetail } from '../../../../../../services/workshop/experience/reflection-effects'
import { resolveAgentOrUser } from '../../../../caller'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const memoryId = getRouterParam(event, 'memoryId')!
  const who = resolveAgentOrUser(event)
  const manager = getWorkshopManager()
  if (who.kind === 'agent') {
    if (who.caller.channelId !== channelId) throw new AppError(403, 'SCOPE_VIOLATION', '仅本 channel 成员可读经验投影')
  }
  else {
    const ch = manager.getChannelForUser(channelId, who.user.id)
    manager.requireOwned(ch.ownerUserId, who.user.id, 'channel')
  }
  const db = getAmlRuntime().db
  const row = db.prepare('SELECT channel_id AS channelId FROM agent_memories WHERE id = ?').get(memoryId) as { channelId?: string } | undefined
  if (!row || row.channelId !== channelId) throw new AppError(404, 'NOT_FOUND', '记忆条目不存在于该频道')
  return experiencePanelDetail(db, memoryId)
})
