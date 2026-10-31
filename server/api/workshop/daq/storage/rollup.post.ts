/**
 * POST /api/workshop/daq/storage/rollup —— 手动触发一轮增量聚合(1m/1h)。
 * 控制面操作:admin/editor;调度器已在 daq 启动插件里按 daq.rollup.intervalMs 周期运行,
 * 本端点用于运维补跑/验收。
 */
import { requireRole, resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { tsdbRunRollup } from '@/server/services/workshop/daq/storage'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  requireRole(event, ['admin', 'editor'])
  const result = await tsdbRunRollup()
  recordOps({
    actor: user.id,
    actorName: user.name,
    actorKind: 'user',
    action: 'daq.storage.rollup',
    kind: 'daq',
    targetKind: 'daq-tsdb',
    targetId: 'daq_rollup',
    summary: result
      ? `手动触发增量聚合:1m ${result.minuteRows} 行 / 1h ${result.hourRows} 行(${result.lines} 条产线)`
      : '手动触发增量聚合:当前后端未启用 rollup',
  })
  return { result }
})
