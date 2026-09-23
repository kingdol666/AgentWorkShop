/**
 * POST /api/workshop/tasks/:id/reassign —— 重新指派待执行/失败任务到其他 worker。
 * 用户手动调配:以任务所在 channel 的 lead 身份执行(与 cancel 同款系统身份模式);
 * 仅 SUBMITTED/FAILED 可改派(状态机校验),旧 assignee 队列自动清退,新 assignee 被唤醒。
 * body: { toAgentId: 目标成员实例 id / 模板 id / 名字(唯一前缀) }
 * - 任务不存在 → 404;目标未命中 → 400;channel 非本人 → 403
 */
// readBody 必须显式从 'h3' 引入:依赖树里同时存在 h3 v1/v2,若依赖 Nuxt 自动导入,
// 值来自 v1 而 event 由 defineApiHandler 以 v2 的 H3Event 定型 → TS2345(typecheck 失败)。
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '../../caller'
import { AppError } from '../../../../utils/errors'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const user = resolveUser(event)
  const body = await readBody(event) as { toAgentId?: string } | undefined
  if (!body?.toAgentId) throw new AppError(400, 'VALIDATION_ERROR', 'toAgentId 必填(改派目标成员)')
  const task = (manager as unknown as {
    getTaskEngine(): { get(id: string): { channelId: string, assigneeId: string } | undefined }
  }).getTaskEngine().get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  const ch = manager.getChannelForUser(task.channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const agents = await manager.listChannelAgents(task.channelId)
  const lead = agents.find(a => a.role === 'lead')
  if (!lead) throw new AppError(400, 'NO_LEAD_AGENT', `channel ${task.channelId} 无 lead,无法以系统身份改派`)
  return manager.reassignTask(task.channelId, lead.id, taskId, body.toAgentId)
})
