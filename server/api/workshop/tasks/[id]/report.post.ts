/**
 * POST /api/workshop/tasks/:id/report —— assignee 上报任务进度/成果(REST 作业面,与 MCP workshop.task.report 同语义)。
 * - 需要 Bearer token;仅任务 assignee 可上报(manager 校验)
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../utils/validate'
import { defineApiHandler } from '../../../../utils/response'
import { getWorkshopManager } from '../../../../plugins/workshop'
import { resolveCaller } from '../../caller'
import type { A2AArtifact } from '../../../../services/workshop/types/a2a'

/** 运行时校验与契约一致;zod 推断形状与契约存在无害差异,as 收窄 */
const artifactSchema = z.object({
  artifactId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
}) as z.ZodType<A2AArtifact>

const reportSchema = z.object({
  progress: z.number().min(0).max(100).optional(),
  artifact: artifactSchema.optional(),
  message: z.string().optional(),
})

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(reportSchema))
  const caller = resolveCaller(event)
  return getWorkshopManager().reportTask(caller.channelId, caller.id, {
    taskId,
    progress: body.progress,
    artifact: body.artifact,
    message: body.message,
  })
})
