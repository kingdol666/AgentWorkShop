/** POST /api/workshop/memory/:id/merge —— 证据并集（以 :id 为基行；不自动晋升）。 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { mergeExperiences } from '@/server/services/workshop/experience/promote'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  const { channelId } = assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const others = Array.isArray(body.memoryIds) ? body.memoryIds.map(String).filter(Boolean) : []
  return mergeExperiences(getAmlRuntime().db, {
    channelId,
    memoryIds: [id, ...others],
    actor: user.id,
    actorName: user.name,
  })
})
