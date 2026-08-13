/**
 * POST /api/workshop/tasks/:id/cancel —— 取消任务(用户手动回收卡死任务)(设计文档 §6.2)。
 * 用户/系统无 caller 身份时,以任务所在 channel 的 lead 身份取消(lead 可取消 channel 内任意任务);
 * 已处终态的任务取消 → 400 INVALID_TRANSITION(manager 状态机校验)。
 * - 任务不存在 → 404 NOT_FOUND
 * - channel 无 lead → 400 NO_LEAD_AGENT(无法以系统身份取消)
 */
import { getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import type { AgentChannelManager } from '../../../../../services/workshop/runtime/manager'
import type { TaskEngine } from '../../../../../services/workshop/runtime/agent-runtime'

/** manager 未公开 TaskEngine 访问;经内部方法只读获取(类型收窄) */
function taskEngineOf(manager: AgentChannelManager): TaskEngine {
  return (manager as unknown as { getTaskEngine(): TaskEngine }).getTaskEngine()
}

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const task = taskEngineOf(manager).get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  // 系统身份:任务所在 channel 的 lead
  const agents = await manager.listAgents(task.channelId)
  const lead = agents.find(a => a.role === 'lead')
  if (!lead) throw new AppError(400, 'NO_LEAD_AGENT', `channel ${task.channelId} 无 lead,无法以系统身份取消`)
  return manager.cancelTask(lead.id, { taskId })
})
