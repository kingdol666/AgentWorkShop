/** POST /api/workshop/memory/:id/annotations —— 人工批注（随宿主条目一起注入）。 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, annotateMemory } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user, actor } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    return annotateMemory(getAmlRuntime().db, { id, body: String(body.body ?? ''), actor })
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
