/**
 * GET /api/workshop/tasks/:id —— 任务详情(含成果 artifacts/history)(设计文档 §6.2)。
 * 任务不存在 → 404 NOT_FOUND。
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../utils/errors'
import { defineApiHandler } from '../../../utils/response'
import { getWorkshopManager } from '../../../plugins/workshop'
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { TaskEngine } from '../../../services/workshop/runtime/agent-runtime'

/** manager 未公开 TaskEngine 访问;经内部方法只读获取(类型收窄) */
function taskEngineOf(manager: AgentChannelManager): TaskEngine {
  return (manager as unknown as { getTaskEngine(): TaskEngine }).getTaskEngine()
}

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const task = taskEngineOf(getWorkshopManager()).get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  return task
})
