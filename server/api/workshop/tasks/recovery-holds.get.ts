/**
 * GET /api/workshop/tasks/recovery-holds —— legacy 恢复保留清单(运维处置面)。
 * admin only:返回当前全部 hold 任务(连接树成员、close_reason、树内消息计数),
 * 供操作员在显式处置(recovery-disposition)前调查。只读,不触发任何重放。
 */
import { requireAdmin } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import type { AgentChannelManager } from '@/server/services/workshop/runtime/manager'
import type { TaskEngine } from '@/server/services/workshop/runtime/agent-runtime'

/** manager 未公开 TaskEngine 访问;经内部方法只读获取(类型收窄,与 retry.post.ts 同口径) */
function taskEngineOf(manager: AgentChannelManager): TaskEngine {
  return (manager as unknown as { getTaskEngine(): TaskEngine }).getTaskEngine()
}

export default defineApiHandler(async (event) => {
  requireAdmin(event)
  const manager = getWorkshopManager()
  const engine = taskEngineOf(manager)
  return { holds: engine.listLegacyRecoveryHolds() }
})
