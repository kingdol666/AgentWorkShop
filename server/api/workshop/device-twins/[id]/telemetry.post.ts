/**
 * POST /api/workshop/device-twins/:id/telemetry —— 数字孪生数据采集(采集器/Agent 推送)。
 * - Bearer 用户 token;body: { telemetry: Record<string, number|string|boolean> }
 * - 也可由外部采集器接入(真实设备 OPC-UA/MQTT 采集器把数据推到这里)
 * - 返回 { twin, derived: { state } }
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo } from '@/server/services/workshop/assets/device-twin.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ telemetry?: Record<string, unknown> }>(event)
  if (!body?.telemetry || typeof body.telemetry !== 'object') throw new AppError(400, 'BAD_REQUEST', 'telemetry 必填(object)')
  const twin = getDeviceTwinRepo().applyTelemetry(id, body.telemetry as Record<string, number | string | boolean>)
  if (!twin) throw new AppError(404, 'NOT_FOUND', `设备不存在: ${id}`)
  return { twin, derived: { state: twin.state } }
})
