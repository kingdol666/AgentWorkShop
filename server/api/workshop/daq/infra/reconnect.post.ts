/**
 * POST /api/workshop/daq/infra/reconnect —— 手动重连(探测→Docker 拉起→重建后端→恢复/停用采集)。
 */
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { daqInfraConfig, daqInfraStatus } from '@/server/services/workshop/daq/infra'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const apply = (globalThis as unknown as { __daqApplyInfra?: (c: DaqInfraConfig) => Promise<void> }).__daqApplyInfra
  if (!apply) {
    return { infra: { ...daqInfraStatus(), warning: '启动插件未就绪,稍后重试' } }
  }
  // cfg 由启动插件闭包持有(与运行配置同源);此处触发一次完整装配
  await apply(daqInfraConfig())
  return { infra: daqInfraStatus() }
})
