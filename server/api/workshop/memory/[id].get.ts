/** GET /api/workshop/memory/:id —— 详情（正文/批注/版本链）。 */
import { getRouterParam, getQuery } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { getMemory, MemoryAdminError } from '@/server/services/workshop/memory/memory-admin'
import { memoryOwnerFilter, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  const q = getQuery(event)
  try {
    const detail = getMemory(getAmlRuntime().db, id, { includeDeleted: q.includeDeleted === '1' })
    const owner = memoryOwnerFilter(user)
    if (owner.ownerUserId !== undefined && detail.ownerUserId !== owner.ownerUserId && user.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', '无权查看该记忆')
    }
    return detail
  }
  catch (err) {
    if (err instanceof MemoryAdminError) throw new AppError(err.statusCode, err.code, err.message)
    throw err
  }
})
