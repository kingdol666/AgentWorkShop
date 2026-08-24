/**
 * PUT /api/workshop/scene/layouts/:channelId —— 放置/更新频道领地(3D 小镇)。
 * - Bearer 用户 token;body: { x, z, radiusX, radiusZ, shape?, rotationY? }
 * - 校验 channel 属主;变更经该频道频道流广播 scene.layout.saved(其他小镇客户端即时同步)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getSceneLayoutRepo } from '@/server/services/workshop/scene/scene-layout.repo'
import { publishSceneLayoutEvent } from '@/server/api/workshop/ws'

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'channelId')!
  const body = await readBody<{ x?: number, z?: number, radiusX?: number, radiusZ?: number, shape?: string, rotationY?: number }>(event)
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireWritable(channel.ownerUserId, user, 'channel')

  const layout = getSceneLayoutRepo().upsert(channelId, {
    x: typeof body?.x === 'number' && Number.isFinite(body.x) ? body.x : 0,
    z: typeof body?.z === 'number' && Number.isFinite(body.z) ? body.z : 0,
    radiusX: typeof body?.radiusX === 'number' && Number.isFinite(body.radiusX) ? body.radiusX : 180,
    radiusZ: typeof body?.radiusZ === 'number' && Number.isFinite(body.radiusZ) ? body.radiusZ : 120,
    shape: body?.shape === 'rect' ? 'rect' : 'ellipse',
    rotationY: typeof body?.rotationY === 'number' && Number.isFinite(body.rotationY) ? body.rotationY : 0,
  })
  publishSceneLayoutEvent(manager, channelId, 'scene.layout.saved', layout)
  return { layout }
})
