/**
 * GET /api/health —— 存活探测(公开,无需认证;供运维/脚本探活)。
 * 返回版本 + 进程 uptime + workshop manager 装配概要。
 * 存活语义:进程可响应即 200;manager 未就绪(启动早期)降级标记 workshop='not_ready',
 * 不抛错——就绪探针可按该字段判断,而探活端点本身不被组件状态拖垮。
 */
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
  return {
    status: 'ok',
    app: cfg.app.name,
    version: cfg.app.version,
    mode: cfg.app.mode,
    uptimeMs: Math.round(process.uptime() * 1000),
    timestamp: new Date().toISOString(),
    workshop,
    ...summary,
  }
})
