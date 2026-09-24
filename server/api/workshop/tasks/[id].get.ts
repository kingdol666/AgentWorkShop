/**
 * GET /api/workshop/tasks/:id —— 任务详情(含成果 artifacts/history)。
 * - 无 token:管理面路径(用户手动查看)
 * - 带 Bearer token:Agent 路径,经 manager.getTask 做同 channel 作用域校验(跨 channel → 403)
 *
 * §8:任务详情必须携带 **channelId + taskId**。传了 channelId 就做强校验 ——
 * 前端切换频道后残留的旧 taskId 会拿到 404,而不是把 A 频道的详情渲染到 B 频道
 * (跨 Channel 串详情)。
 */
import { getQuery, getRouterParam } from 'h3'
import { resolveCallerOrNull, resolveUser } from '../caller'
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
  const expectChannelId = String(getQuery(event).channelId ?? '').trim()
  const manager = getWorkshopManager()
  const caller = resolveCallerOrNull(event)
  if (caller) {
    // Agent 路径:作用域校验(同 channel 可见,跨 channel 抛 SCOPE_VIOLATION)
    return manager.getTask(caller.channelId, caller.id, taskId)
  }
  const task = taskEngineOf(manager).get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  if (expectChannelId && task.channelId !== expectChannelId) {
    throw new AppError(404, 'NOT_FOUND', `任务 ${taskId} 不属于 channel ${expectChannelId}`)
  }
  // 用户路径:channel 读取守卫(本人/遗留公共)
  const user = resolveUser(event)
  manager.getChannelForUser(task.channelId, user.id)
  return task
})
