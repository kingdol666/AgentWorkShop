/**
 * POST /api/workshop/tasks/:id/supersede —— lead 把 FAILED/CANCELED 子任务分支标记为被替代
 * (整改计划 2026-10-30 阶段1/F1:失败/取消分支的显式处置出口;与 host 工具 supersede_task 同语义)。
 * - 需要 Bearer token;仅父任务 assignee(lead)可处置(manager 校验)
 * - 替代关系落库(superseded_by_task_id),父任务收口不再被该分支阻塞
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { resolveCaller } from '../../caller'

const supersedeSchema = z.object({
  replacementTaskId: z.string().min(1),
  reason: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const caller = resolveCaller(event)
  const body = await readValidatedBody(event, zValidator(supersedeSchema))
  return getWorkshopManager().supersedeTask(caller.channelId, caller.id, {
    taskId,
    replacementTaskId: body.replacementTaskId,
    reason: body.reason,
  })
})
