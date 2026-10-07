/**
 * GET /api/health —— 存活探测(公开,无需认证;供运维/脚本探活)。
 * 返回版本 + 进程 uptime + workshop manager 装配概要 + 内存水位(P0-4)。
 * 存活语义:进程可响应即 200;manager 未就绪(启动早期)降级标记 workshop='not_ready',
 * 不抛错——就绪探针可按该字段判断,而探活端点本身不被组件状态拖垮。
 */
import v8 from 'node:v8'
import { useServerConfig } from '../utils/config'
import { defineApiHandler } from '../utils/response'
import { getWorkshopManager } from '../plugins/workshop'

export default defineApiHandler(async () => {
  const cfg = useServerConfig()
  let workshop: 'ready' | 'not_ready' = 'ready'
  let summary: { wiredAgents: number, activeChannels: number } | null = null
  try {
    const status = getWorkshopManager().runtimeStatus()
    summary = { wiredAgents: status.wiredAgents.length, activeChannels: status.activeChannels.length }
  }
  catch {
    workshop = 'not_ready'
  }
  // P0-4 内存水位(heapUsed 相对 --max-old-space-size;exit 134 = 堆耗尽,与其同源)
  const mu = process.memoryUsage()
  const heapLimit = v8.getHeapStatistics().heap_size_limit
  return {
    status: 'ok',
    app: cfg.app.name,
    version: cfg.app.version,
    mode: cfg.app.mode,
    uptimeMs: Math.round(process.uptime() * 1000),
    timestamp: new Date().toISOString(),
    workshop,
    ...summary,
    memory: {
      heapUsedMb: Math.round(mu.heapUsed / 1048576),
      heapLimitMb: Math.round(heapLimit / 1048576),
      rssMb: Math.round(mu.rss / 1048576),
      externalMb: Math.round(mu.external / 1048576),
      heapRatio: heapLimit > 0 ? Number((mu.heapUsed / heapLimit).toFixed(4)) : 0,
    },
  }
})
