/**
 * PATCH /api/workshop/device-twins/:id —— 更新数字孪生设备(含 3D 场景落点 transform)。
 * - Bearer 用户 token;body: { name?, modelRef?, posX?, posZ?, rotationY?, scale? }
 * - 落点坐标/朝向/缩放由 3D 小镇编辑模式拖拽/滑杆结束防抖写入;
 * - 更新后广播 device.updated(全部已连 peer,其他小镇客户端即时同步场景节点)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo, deviceScenePayload } from '@/server/services/workshop/assets/device-twin.repo'
import { broadcastSceneEvent } from '@/server/api/workshop/ws'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ name?: string, modelRef?: string, posX?: number, posZ?: number, rotationY?: number, scale?: number }>(event)
  const twin = getDeviceTwinRepo().update(id, {
    name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
    modelRef: typeof body?.modelRef === 'string' ? body.modelRef.trim() : undefined,
    posX: typeof body?.posX === 'number' && Number.isFinite(body.posX) ? Math.round(body.posX * 10) / 10 : undefined,
    posZ: typeof body?.posZ === 'number' && Number.isFinite(body.posZ) ? Math.round(body.posZ * 10) / 10 : undefined,
    rotationY: typeof body?.rotationY === 'number' && Number.isFinite(body.rotationY) ? Math.round(body.rotationY * 10) / 10 : undefined,
    scale: typeof body?.scale === 'number' && Number.isFinite(body.scale) && body.scale > 0 ? Math.round(body.scale * 100) / 100 : undefined,
  })
  if (!twin) throw new AppError(404, 'NOT_FOUND', `设备不存在: ${id}`)
  broadcastSceneEvent('device.updated', deviceScenePayload(twin))
  return { twin }
})
