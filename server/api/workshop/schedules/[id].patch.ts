/**
 * PATCH /api/workshop/schedules/:id —— 更新定时任务(v16)。
 * 改触发参数(mode/intervalMs/dailyTime)即重算 next_run_at;
 * enabled 0/1 走状态机(停用置 disabled;启用重置连续失败并重新计时)。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

const patchScheduleSchema = z.object({
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  mode: z.enum(['interval', 'daily']).optional(),
  intervalMs: z.number().int().min(60_000).max(2_592_000_000).optional(),
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'dailyTime 须为 HH:MM(24 小时制)').optional(),
  enabled: z.union([z.literal(0), z.literal(1)]).optional(),
  maxConsecutiveFailures: z.number().int().min(0).max(999).optional(),
})

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(patchScheduleSchema))
  return getWorkshopManager().updateSchedule(id, user, body)
})
