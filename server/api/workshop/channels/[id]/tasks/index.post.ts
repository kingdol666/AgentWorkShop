/**
 * POST /api/workshop/channels/:id/tasks —— 向 channel 发任务 → 自动路由 lead(设计文档 §6.2)。
 * - channel 不存在 → 404 NOT_FOUND
 * - channel 无 lead → 400 NO_LEAD_AGENT(manager 校验)
 * 支持 mode 参数:goal / loop / pipeline
 */
import { z } from 'zod'
import { getRouterParam, readValidatedBody } from 'h3'
import { zValidator } from '../../../../../utils/validate'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import type { Part } from '../../../../../services/workshop/types/a2a'

/** A2A 消息片段(Part):四种变体(text/data/url/raw) */
const partSchema = z.union([
  z.object({
    text: z.string(),
    mediaType: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    data: z.unknown(),
    mediaType: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    url: z.string(),
    mediaType: z.string().optional(),
    filename: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    raw: z.string(),
    mediaType: z.string().optional(),
    filename: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]) as z.ZodType<Part>

const submitTaskSchema = z.object({
  title: z.string().min(1, 'title 必填'),
  description: z.string().optional(),
  parts: z.array(partSchema).optional(),
  mode: z.enum(['goal', 'loop', 'pipeline']).optional(),
  modeConfig: z.object({
    intervalMs: z.number().optional(),
    maxIterations: z.number().optional(),
    goalCriteria: z.string().optional(),
    stages: z.array(z.object({
      name: z.string(),
      description: z.string(),
      assigneeId: z.string().optional(),
    })).optional(),
  }).optional(),
})

export default defineApiHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, zValidator(submitTaskSchema))
  const manager = getWorkshopManager()
  const channel = (await manager.listChannels()).find(c => c.id === channelId)
  if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
  return manager.submitChannelTask({
    channelId,
    title: body.title,
    description: body.description,
    parts: body.parts,
    mode: body.mode,
    modeConfig: body.modeConfig,
  })
})
