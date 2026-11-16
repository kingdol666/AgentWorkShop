/**
 * POST /api/workshop/daq/test-driver —— 连接测试(按协议参数建连+读一次,不落库)。
 * body: { driver: DaqDriverKind, driverConfig: Record<string, string|number|boolean> }
 * → DriverTestResult { ok, message, sampleValue?, latencyMs? }
 * 前端添加节点向导"测试连接"直达;通过后可直接创建节点开始采集。
 *
 * 2026-10-28 安全修复:仅 admin/editor 可调用(此前任意登录用户可提交任意连接配置
 * 让服务端连内网目标);driverConfig.allowPrivateHost 不再接受调用方自填,
 * 私网白名单只认服务端开关 AW_TEST_DRIVER_ALLOW_PRIVATE=1。
 */
import { readBody } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { bindDaqHost } from '@/server/services/workshop/daq/host-bindings'
import { getDaqController } from '@/server/services/workshop/daq/daq-controller'
import { broadcastSceneEvent } from '../../../services/workshop/scene-events'
import { requireDriverKind } from '@/server/services/workshop/daq/drivers'
import type { DaqDriverKind } from '#shared/daq-protocol'

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin', 'editor'])
  bindDaqHost(broadcastSceneEvent)
  const body = await readBody<{ driver?: DaqDriverKind, driverConfig?: Record<string, string | number | boolean> }>(event) ?? {}
  if (!body.driver) return { ok: false, message: '缺少 driver' }
  const cfg: Record<string, string | number | boolean> = { ...(body.driverConfig ?? {}) }
  // 显式 false(而不是 delete):HTTP 驱动的 legacyAllowPrivateWhenUnset 在字段缺失时
  // 会沿用历史放行行为,删除字段等于绕过 2026-10-28 的服务端白名单。只有运维开关能放行。
  cfg.allowPrivateHost = process.env.AW_TEST_DRIVER_ALLOW_PRIVATE === '1' ? 'true' : 'false'
  const result = await getDaqController().testDriver(requireDriverKind(body.driver), cfg)
  return { test: result }
})
