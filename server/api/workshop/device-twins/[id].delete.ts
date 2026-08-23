/**
 * DELETE /api/workshop/device-twins/:id —— 删除数字孪生设备。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo } from '@/server/services/workshop/assets/device-twin.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const ok = getDeviceTwinRepo().remove(id)
  if (!ok) throw new AppError(404, 'NOT_FOUND', `设备不存在: ${id}`)
  return { deleted: true }
})
