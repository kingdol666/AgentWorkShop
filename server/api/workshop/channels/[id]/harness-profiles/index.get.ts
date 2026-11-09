/**
 * GET /api/workshop/channels/:id/harness-profiles —— Harness Profile 版本列表(WP-B1,只读)。
 * 返回各版本(含 candidate/shadow)与当前 active;无 active 时 active=null(零行为)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { createHarnessProfileRepo } from '../../../../../services/workshop/experience/harness-profile'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const ch = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const repo = createHarnessProfileRepo(getAmlRuntime().db)
  return { active: repo.activeOf(channelId), versions: repo.listByChannel(channelId) }
})
