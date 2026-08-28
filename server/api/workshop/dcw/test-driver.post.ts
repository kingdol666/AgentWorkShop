/**
 * POST /api/workshop/dcw/test-driver —— 连接测试(body: { driver, driverConfig })。
 */
import { readBody } from 'h3'
import type { DcwDriverKind } from '#shared/dcw-protocol'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<{ driver?: DcwDriverKind, driverConfig?: Record<string, unknown> }>(event) ?? {}
  return { test: await getDcwController().testDriver(body.driver ?? 'mock', body.driverConfig ?? {}) }
})
