/**
 * POST /api/workshop/daq/infra/reconnect —— 手动重连(探测→Docker 拉起→重建后端→恢复/停用采集)。
 *
 * 2026-10-28 安全修复:此前仅 resolveUser —— 任意登录用户都能触发 docker compose、
 * 重建后端并全局启停采样;总控 /daq/controller 却要求 admin/editor,口径不一致。
 * 同时加单飞:并发 reconnect 会互相打断采集。
 */
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { daqInfraConfig, daqInfraStatus, type DaqInfraConfig } from '@/server/services/workshop/daq/infra'

const g = globalThis as unknown as { __daqReconnectInFlight?: boolean }

export default defineApiHandler(async (event) => {
  requireRole(event, ['admin', 'editor'])
  const apply = (globalThis as unknown as { __daqApplyInfra?: (c: DaqInfraConfig) => Promise<void> }).__daqApplyInfra
  if (!apply) {
    return { infra: { ...daqInfraStatus(), warning: '启动插件未就绪,稍后重试' } }
  }
  if (g.__daqReconnectInFlight) {
    throw new AppError(409, 'RECONNECT_IN_FLIGHT', '已有一次基础设施重连在执行,请等待完成后再试')
  }
  g.__daqReconnectInFlight = true
  try {
    // cfg 由启动插件闭包持有(与运行配置同源);此处触发一次完整装配
    await apply(daqInfraConfig())
    return { infra: daqInfraStatus() }
  }
  finally {
    g.__daqReconnectInFlight = false
  }
})
