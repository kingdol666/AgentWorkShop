/**
 * GET /api/workshop/channels —— channel 列表(设计文档 §6.2)。
 * v16:附「定时」标志 —— scheduledCount = 该 channel 启用的定时计划数(0 = 无定时任务)。
 */
import { defineApiHandler } from '../../utils/response'
import { resolveUser } from './caller'
import { getWorkshopManager } from '../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const manager = getWorkshopManager()
  const channels = manager.listChannelsForUser(user.id)
  const flags = manager.channelScheduleFlags()
  return channels.map(ch => ({
    ...ch,
    scheduledCount: flags.get(ch.id) ?? 0,
  }))
})
