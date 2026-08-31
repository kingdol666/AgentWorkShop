/**
 * POST /api/workshop/daq/test-driver —— 连接测试(按协议参数建连+读一次,不落库)。
 * body: { driver: DaqDriverKind, driverConfig: Record<string, string|number|boolean> }
 * → DriverTestResult { ok, message, sampleValue?, latencyMs? }
 * 前端添加节点向导"测试连接"直达;通过后可直接创建节点开始采集。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { normalizeDriverKind } from '@/server/services/workshop/daq/drivers'
import type { DaqDriverKind } from '#shared/daq-protocol'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  bindDaqHost(broadcastSceneEvent)
  const body = await readBody<{ driver?: DaqDriverKind, driverConfig?: Record<string, string | number | boolean> }>(event) ?? {}
  if (!body.driver) return { ok: false, message: '缺少 driver' }
  const result = await getDaqController().testDriver(normalizeDriverKind(body.driver), body.driverConfig ?? {})
  return { test: result }
})
