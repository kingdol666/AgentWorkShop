/**
 * PATCH /api/workshop/channels/:id/sessions/:sid/runtime/:agentId
 * 修改单个 manual session 的 runtime 元数据（harness/provider/model/effort/runtimePrompt/prefab）。
 * 只在下一回合消息入口热切换；当前执行中的回合不打断。owner/admin 才可写。
 */
import { getRouterParam, readValidatedBody } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { zValidator } from '@/server/utils/validate'
import { getWorkshopManager } from '@/server/plugins/workshop'

const prefabBindingSchema = z.object({
  prefabId: z.string().trim().min(1).max(200),
  revision: z.number().int().positive(),
  slotValues: z.record(z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/), z.string().max(20000)).optional(),
}).strict()

const overridesSchema = z.object({
  /** 目标执行引擎；null = 回到 clone 继承 */
  harness: z.string().trim().min(1).max(64).nullable().optional(),
  /** provider/model/effort：空串 = 显式抑制继承值（切换 harness 时清除旧引擎选择） */
  provider: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(64).nullable().optional(),
  runtimePrompt: z.string().trim().max(4000).nullable().optional(),
  prefabBinding: prefabBindingSchema.nullable().optional(),
}).strict()

const bodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reset: z.boolean().optional(),
  overrides: overridesSchema.optional(),
}).strict()

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const sessionId = getRouterParam(event, 'sid')!
  const agentId = getRouterParam(event, 'agentId')!
  const body = await readValidatedBody(event, zValidator(bodySchema))
  const manager = getWorkshopManager()
  const runtime = await manager.updateSessionRuntime(channelId, sessionId, agentId, body, user)
  return { runtime, effectiveAt: 'next_turn' }
})
