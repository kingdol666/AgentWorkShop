/**
 * POST /api/workshop/dcw/test-driver —— 连接测试(body: { driver, driverConfig })。
 *
 * 2026-10-28 安全修复:仅 admin/editor 可调用;allowPrivateHost 只认服务端开关。
 */
import { readBody } from 'h3'
import type { DcwDriverKind } from '#shared/dcw-protocol'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDcwBroadcast, getDcwController } from '@/server/services/workshop/dcw/dcw-controller'
import { broadcastSceneEvent } from '@/server/services/workshop/scene-events'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin', 'editor'])
  bindDcwBroadcast(broadcastSceneEvent)
  const body = await readBody<{ driver?: DcwDriverKind, driverConfig?: Record<string, unknown> }>(event) ?? {}
  const cfg: Record<string, unknown> = { ...(body.driverConfig ?? {}) }
  delete cfg.allowPrivateHost
  if (process.env.AW_TEST_DRIVER_ALLOW_PRIVATE === '1') cfg.allowPrivateHost = 'true'
  return { test: await getDcwController().testDriver(body.driver ?? 'mock', cfg) }
})
