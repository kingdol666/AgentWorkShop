/**
 * POST /api/workshop/schedules —— 创建定时任务(v16)。
 * body: { channelId, name, title, description?, mode: 'interval'|'daily', intervalMs?, dailyTime?, maxConsecutiveFailures? }
 * - interval 模式:intervalMs ≥ 60000(60s 下限)
 * - daily 模式:dailyTime 'HH:MM'(24 小时制,本地时区)
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../../utils/validate'
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { getWorkshopManager } from '../../../plugins/workshop'

const createScheduleSchema = z.object({
  channelId: z.string().min(1, 'channelId 必填'),
  name: z.string().min(1, 'name 必填'),
  title: z.string().min(1, 'title 必填'),
  description: z.string().optional(),
  mode: z.enum(['interval', 'daily']),
  /** 固定间隔毫秒(interval 模式;下限 60s) */
  intervalMs: z.number().int().min(60_000).max(2_592_000_000).optional(),
  /** 每日定点 'HH:MM'(daily 模式;本地时区) */
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'dailyTime 须为 HH:MM(24 小时制)').optional(),
  /** 连续失败熔断阈值(0 = 不自动停用) */
  maxConsecutiveFailures: z.number().int().min(0).max(999).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(createScheduleSchema))
  return getWorkshopManager().createSchedule(user, body)
})
