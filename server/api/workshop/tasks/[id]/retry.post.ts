/**
 * POST /api/workshop/tasks/:id/retry —— HITL 重试 FAILED 任务(lead/worker 任务均可)。
 * 用户/系统无 caller 身份时,以任务所在 channel 的 lead 身份调用 manager.retryTask:
 * 优先原 assignee,否则选队列最短空闲 worker,重新投递执行。
 * - 任务不存在 → 404;任务非 FAILED → 400 INVALID_STATE
 * - channel 无 lead → 400 NO_LEAD_AGENT;无可用 worker → 400 NO_WORKER
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getWorkshopManager } from '@/server/plugins/workshop'
import type { AgentChannelManager } from '@/server/services/workshop/runtime/manager'
import type { TaskEngine } from '@/server/services/workshop/runtime/agent-runtime'

/** manager 未公开 TaskEngine 访问;经内部方法只读获取(类型收窄) */
function taskEngineOf(manager: AgentChannelManager): TaskEngine {
  return (manager as unknown as { getTaskEngine(): TaskEngine }).getTaskEngine()
}

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const task = taskEngineOf(manager).get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  const user = resolveUser(event)
  const ch = manager.getChannelForUser(task.channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const agents = await manager.listChannelAgents(task.channelId)
  const lead = agents.find(a => a.role === 'lead')
  if (!lead) throw new AppError(400, 'NO_LEAD_AGENT', `channel ${task.channelId} 无 lead,无法以系统身份重试`)
  return manager.retryTask(lead.channelId, lead.id, taskId)
})
