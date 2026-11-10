/**
 * GET /api/workshop/channels/:id/improvement-proposals —— 提案清单（含 pending）。
 *
 * 背景（2026-11-10 审计）：`rejected` / `expired` 两个状态全库无写者，提案表只进不退；
 * 人类侧也没有列表面。本端点补齐读面，并在读时惰性执行过期清理（幂等，只动 pending）。
 * 鉴权：频道 owner/admin（与 /memories 面同口径）。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { createImprovementRepo, expireStaleProposals } from '../../../../../services/workshop/db/improvement.repo'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const db = getAmlRuntime().db
  expireStaleProposals(db)
  return { proposals: createImprovementRepo(db).listByChannel(channelId, { limit: 100 }) }
})
