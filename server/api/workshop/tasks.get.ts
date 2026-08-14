/**
 * GET /api/workshop/tasks —— caller 所在 channel 的任务列表(带进度)。
 * - 需要 Bearer token;作用域强制 caller 的 channel(跨 channel 不可见)
 * - 与 /api/workshop/channels/:id/tasks(管理面,按 channelId)互补
 */
import { defineApiHandler } from '../../utils/response'
import { getWorkshopManager } from '../../plugins/workshop'
import { resolveCaller } from './caller'

export default defineApiHandler(async (event) => {
  const caller = resolveCaller(event)
  return getWorkshopManager().listTasks(caller.channelId, caller.id)
})
