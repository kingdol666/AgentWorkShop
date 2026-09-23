/**
 * POST /api/workshop/tasks/:id/update —— 修改待执行任务(标题/描述)。
 * 用户手动改题:以任务所在 channel 的 lead 身份执行(与 cancel 同款系统身份模式);
 * 仅 SUBMITTED/ASSIGNED 可改(执行中/终态 → 400 INVALID_TRANSITION,状态机校验);
 * 修改后作废旧投递并重发 assign,assignee 队列内容随之刷新。
 * - 任务不存在 → 404;channel 非本人 → 403;无可更新字段 → 400
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
  const task = (manager as unknown as { getTaskEngine(): { get(id: string): { channelId: string } | undefined } }).getTaskEngine().get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  const user = resolveUser(event)
  const ch = manager.getChannelForUser(task.channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  const body = await readBody(event) as { title?: string, description?: string } | undefined
  if (!body || (body.title === undefined && body.description === undefined)) {
    throw new AppError(400, 'VALIDATION_ERROR', '无可更新字段(title/description 至少一项)')
  }
  const agents = await manager.listChannelAgents(task.channelId)
  const lead = agents.find(a => a.role === 'lead')
  if (!lead) throw new AppError(400, 'NO_LEAD_AGENT', `channel ${task.channelId} 无 lead,无法以系统身份修改`)
  return manager.updateTask(task.channelId, lead.id, taskId, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
  })
})
