/**
 * POST /api/workshop/tasks/:id/complete —— assignee 完成任务并交付成果(REST 作业面,与 MCP workshop.task.complete 同语义)。
 * - 需要 Bearer token;仅任务 assignee 可完成(manager 校验);完成后自动触发父任务汇总(若为子任务)
 * - 任务需处于 WORKING 状态(ASSIGNED 未接取时完成 → 400 INVALID_TRANSITION)
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

const completeSchema = z.object({
  artifacts: z.array(artifactSchema).optional(),
})

export default defineApiHandler(async (event) => {
  const taskId = getRouterParam(event, 'id')!
  const caller = resolveCaller(event)
  const body = await readValidatedBody(event, zValidator(completeSchema))
  return getWorkshopManager().completeTask(caller.channelId, caller.id, { taskId, artifacts: body.artifacts })
})
