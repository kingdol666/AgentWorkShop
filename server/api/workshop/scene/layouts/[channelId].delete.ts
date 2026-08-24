/**
 * DELETE /api/workshop/scene/layouts/:channelId —— 取消频道领地放置(从 3D 小镇移除)。
 * - Bearer 用户 token;校验 channel 属主;广播 scene.layout.removed(客户端移除领地+其 Agent)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getSceneLayoutRepo } from '@/server/services/workshop/scene/scene-layout.repo'
import { publishSceneLayoutEvent } from '@/server/api/workshop/ws'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'channelId')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')
  const ok = getSceneLayoutRepo().remove(channelId)
  if (!ok) throw new AppError(404, 'NOT_FOUND', `频道未放置: ${channelId}`)
  publishSceneLayoutEvent(manager, channelId, 'scene.layout.removed', { channelId })
  return { deleted: true }
})
