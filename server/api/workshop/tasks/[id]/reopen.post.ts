/**
 * POST /api/workshop/tasks/:id/reopen —— 重开终态根任务(mirror retry.post.ts 鉴权模式)。
 * 仅 FAILED/CANCELED 根;创建承接新根(FIFO 排队尾+全新预算),description 带 [reopen:<id8>] 溯源;
 * 同源在途重开单 → 409 ROOT_REOPEN_IN_FLIGHT。无 caller 身份时以频道 lead 身份提交。
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { getWorkshopManager } from '@/server/plugins/workshop'

const reopenSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(reopenSchema)).catch(() => ({}) as z.infer<typeof reopenSchema>)
  const manager = getWorkshopManager()
  const task = (manager as unknown as { getTaskEngine?: () => { get: (id: string) => { channelId: string } | undefined } }).getTaskEngine?.().get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  const user = resolveUser(event)
  const ch = manager.getChannelForUser(task.channelId, user.id)
  manager.requireOwned(ch.ownerUserId, user.id, 'channel')
  return manager.reopenTask({
    channelId: task.channelId,
    taskId,
    title: body.title,
    description: body.description,
    fromLabel: user.name,
  })
})
