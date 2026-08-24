/**
 * DELETE /api/workshop/device-twins/:id —— 删除数字孪生设备。
 * 删除前广播 device.deleted(其他小镇客户端即时移除场景节点)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo } from '@/server/services/workshop/assets/device-twin.repo'
import { broadcastSceneEvent } from '@/server/api/workshop/ws'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const twin = getDeviceTwinRepo().findById(id)
  const ok = getDeviceTwinRepo().remove(id)
  if (!ok) throw new AppError(404, 'NOT_FOUND', `设备不存在: ${id}`)
  broadcastSceneEvent('device.deleted', { id, name: twin?.name ?? '' })
  return { deleted: true }
})
