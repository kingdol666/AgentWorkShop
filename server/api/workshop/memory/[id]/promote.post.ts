/**
 * POST /api/workshop/memory/:id/promote —— 经验晋升（candidate→validated / →retired）。
 * 晋升会在同一事务里确保版本头（deployment=none），**不等于部署**：需再调 /deploy。
 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { promoteExperience } from '@/server/services/workshop/experience/promote'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  const { channelId } = assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const to = body.to === 'retired' ? 'retired' : 'validated'
  return promoteExperience(getAmlRuntime().db, {
    memoryId: id,
    channelId,
    to,
    actor: user.id,
    actorName: user.name,
  })
})
