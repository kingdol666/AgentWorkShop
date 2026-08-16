/**
 * GET /api/workshop/channels/:id/tasks —— 任务列表(含进度)(设计文档 §6.2)。
 * manager 未公开 channel 级任务查询,经内部 TaskEngine 只读获取(与运行时同一实例)。
 * channel 不存在 → 404 NOT_FOUND。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '../../../caller'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import type { AgentChannelManager } from '../../../../../services/workshop/runtime/manager'
import type { TaskEngine } from '../../../../../services/workshop/runtime/agent-runtime'

/** manager 未公开 TaskEngine 访问;经内部方法只读获取(类型收窄) */
function taskEngineOf(manager: AgentChannelManager): TaskEngine {
  return (manager as unknown as { getTaskEngine(): TaskEngine }).getTaskEngine()
}

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  manager.getChannelForUser(channelId, user.id)
  return taskEngineOf(manager).list(channelId)
})
