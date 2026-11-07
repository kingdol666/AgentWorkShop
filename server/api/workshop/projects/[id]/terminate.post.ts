/**
 * POST /api/workshop/projects/:id/terminate —— owner 终止项目（级联终结）。
 * body: { reason }（必填，审计需要）。
 * 语义：全部未终结工作项 CANCELED + root 任务树 cancelTree（频道侧执行即停）
 * + 待批审批过期 + 项目状态 → canceled（终态，不可 resume）。
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { resolveUser } from '../../caller'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getProjectService } from '../../../../services/workshop/projects/service'

const schema = z.object({ reason: z.string().min(1) })

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readValidatedBody(event, zValidator(schema))
  return getProjectService().terminate(getRouterParam(event, 'id')!, user, body.reason)
})
