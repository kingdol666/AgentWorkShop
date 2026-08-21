/**
 * POST /api/workshop/tasks/:id/dispatch —— lead 分解并指派子任务(REST 作业面,与 MCP workshop.task.dispatch 同语义)。
 * - 需要 Bearer token;仅 lead 可派发(manager 校验);父任务转 WAITING
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { resolveCaller } from '../../caller'

const dispatchSchema = z.object({
  assigneeId: z.string().min(1, 'assigneeId 必填'),
  title: z.string().min(1, 'title 必填'),
  description: z.string().optional(),
  parts: z.array(z.unknown()).optional(),
})

export default defineApiHandler(async (event) => {
  const parentTaskId = getRouterParam(event, 'id')!
  const caller = resolveCaller(event)
  const body = await readValidatedBody(event, zValidator(dispatchSchema))
  return getWorkshopManager().dispatchTask(caller.channelId, caller.id, {
    parentTaskId,
    assigneeId: body.assigneeId,
    title: body.title,
    description: body.description,
    parts: body.parts as never,
  })
})
