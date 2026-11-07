/**
 * POST /api/workshop/projects/:id/continue —— 项目持续开发。
 *
 * 把 owner 的补充需求作为群聊消息发给同一个 Project Leader；completed/paused
 * 项目会先回到 active，Leader 可提出 replan（新增增量交付物/工作项），owner
 * 批准后走既有物化/派发/L1/L2 闭环。archived 不可继续。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '../../caller'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getProjectService } from '../../../../services/workshop/projects/service'

const schema = z.object({
  message: z.string().min(1).max(8000),
  /** 客户端幂等键：重复提交同一条补充需求不会重复投递 */
  clientMessageId: z.string().min(1).max(200).optional(),
})

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().continueProject(getRouterParam(event, 'id')!, user, body)
})
