/** POST /api/workshop/memory/:id/pin —— 置顶/取消置顶（注入优先级）。 */
import { readBody, getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { MemoryAdminError, setMemoryPinned } from '@/server/services/workshop/memory/memory-admin'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    return setMemoryPinned(getAmlRuntime().db, id, body.pinned === true)
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
