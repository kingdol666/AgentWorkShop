/**
 * POST /api/workshop/memory/:id/deploy —— 显式部署 / 撤下（人工，无评测证据）。
 * target: 'active' | 'withdrawn'。同域（channel/line/product/global）只保留一个 active。
 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { deployExperience } from '@/server/services/workshop/experience/deploy'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  const { channelId } = assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const target = body.target === 'withdrawn' ? 'withdrawn' : 'active'
  if (body.target !== 'active' && body.target !== 'withdrawn') {
    throw new AppError(422, 'INVALID_TARGET', 'target 必须是 \'active\' 或 \'withdrawn\'')
  }
  return deployExperience(getAmlRuntime().db, {
    memoryId: id,
    channelId,
    target,
    actor: user.id,
    actorName: user.name,
    reason: typeof body.reason === 'string' ? body.reason : '',
  })
})
