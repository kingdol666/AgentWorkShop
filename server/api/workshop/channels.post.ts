/**
 * POST /api/workshop/channels —— 创建 channel(可带 leadAgent 定义与 workspace)(设计文档 §6.2)。
 * - workspace 缺省 → data/workspaces/<channelId>(自动创建目录)
 * - 创建 lead 后同步启动其 SchedulerLoop(与 plugin 启动恢复同路径)
 */
import { z } from 'zod'
import { readValidatedBody } from 'h3'
import { zValidator } from '../../utils/validate'
import { defineApiHandler } from '../../utils/response'
import { getWorkshopManager, ensureLeadSchedulerLoop } from '../../plugins/workshop'

const createChannelSchema = z.object({
  name: z.string().min(1, 'name 必填'),
  description: z.string().optional(),
  /** channel 独立工作目录(omp 子进程 cwd);缺省 data/workspaces/<channelId> */
  workspace: z.string().optional(),
  leadAgent: z
    .object({
      name: z.string().min(1, 'leadAgent.name 必填'),
      harness: z.string().min(1, 'leadAgent.harness 必填'),
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})

export default defineApiHandler(async (event) => {
  const body = await readValidatedBody(event, zValidator(createChannelSchema))
  const manager = getWorkshopManager()
  const result = await manager.createChannel({
    name: body.name,
    description: body.description,
    workspace: body.workspace,
    leadAgent: body.leadAgent,
  })
  if (result.leadAgentId) {
    ensureLeadSchedulerLoop(manager, result.channelId)
  }
  return result
})
