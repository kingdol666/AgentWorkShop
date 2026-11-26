/** GET /api/workshop/memory/:id/revisions —— 版本链（覆写前原文）。 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { createMemoryRepo } from '@/server/services/workshop/db/memory.repo'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  return { revisions: createMemoryRepo(getAmlRuntime().db).listRevisions(id) }
})
