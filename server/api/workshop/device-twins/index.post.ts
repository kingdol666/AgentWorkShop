/**
 * POST /api/workshop/device-twins —— 创建数字孪生设备。
 * - Bearer 用户 token;body: { name, modelRef?, workspaceId?, kind?, controls?, telemetry? }
 * - 返回 { twin }
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getDeviceTwinRepo, type DeviceTwin } from '@/server/services/workshop/assets/device-twin.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{ name?: string, modelRef?: string, workspaceId?: string, kind?: string, controls?: string[], telemetry?: Record<string, unknown> }>(event)
  if (!body?.name?.trim()) throw new AppError(400, 'BAD_REQUEST', 'name 必填')
  const twin = getDeviceTwinRepo().create({
    name: body.name.trim(),
    modelRef: body.modelRef ?? '',
    workspaceId: body.workspaceId ?? '',
    kind: (body.kind === 'environment' || body.kind === 'asset' ? body.kind : 'device') as DeviceTwin['kind'],
    controls: body.controls ?? [],
    telemetry: (body.telemetry ?? {}) as Record<string, number | string | boolean>,
  })
  return { twin }
})
