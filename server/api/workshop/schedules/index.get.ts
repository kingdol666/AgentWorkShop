/**
 * GET /api/workshop/schedules —— 定时任务列表(v16)。
 * 用户视角:本人 + 遗留公共 channel 的计划;admin 全量。附 channel 名。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  return getWorkshopManager().listSchedulesForUser(user)
})
