/**
 * POST /api/workshop/device-twins —— 创建数字孪生设备。
 * - Bearer 用户 token;body: { name, modelRef?, workspaceId?, kind?, controls?, telemetry?, posX?, posZ?, rotationY?, scale? }
 * - 创建后广播 device.created(3D 小镇拖入场景即建,其他客户端即时同步)。
 * - 返回 { twin }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo, deviceScenePayload, type DeviceTwin } from '@/server/services/workshop/assets/device-twin.repo'
import { broadcastSceneEvent } from '@/server/api/workshop/ws'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ name?: string, modelRef?: string, workspaceId?: string, kind?: string, controls?: string[], telemetry?: Record<string, unknown>, posX?: number, posZ?: number, rotationY?: number, scale?: number }>(event)
  if (!body?.name?.trim()) throw new AppError(400, 'BAD_REQUEST', 'name 必填')
  const twin = getDeviceTwinRepo().create({
    name: body.name.trim(),
    modelRef: body.modelRef ?? '',
    workspaceId: body.workspaceId ?? '',
    kind: (body.kind === 'environment' || body.kind === 'asset' || body.kind === 'daq' ? body.kind : 'device') as DeviceTwin['kind'],
    controls: body.controls ?? [],
    telemetry: (body.telemetry ?? {}) as Record<string, number | string | boolean>,
    posX: typeof body.posX === 'number' && Number.isFinite(body.posX) ? Math.round(body.posX * 10) / 10 : undefined,
    posZ: typeof body.posZ === 'number' && Number.isFinite(body.posZ) ? Math.round(body.posZ * 10) / 10 : undefined,
    rotationY: typeof body.rotationY === 'number' && Number.isFinite(body.rotationY) ? Math.round(body.rotationY * 10) / 10 : undefined,
    scale: typeof body.scale === 'number' && Number.isFinite(body.scale) && body.scale > 0 ? Math.round(body.scale * 100) / 100 : undefined,
  })
  broadcastSceneEvent('device.created', deviceScenePayload(twin))
  return { twin }
})
