/**
 * DELETE /api/workshop/channels/:id —— 删除 channel(级联删除 agents/messages/tasks)(设计文档 §6.2)。
 * channel 不存在 → 404 NOT_FOUND。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../caller'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  await manager.removeChannel(channelId)
  return { ok: true }
})
