/**
 * DELETE /api/workshop/eda/golden/:id —— 删除 golden(创建者/admin)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { deleteGolden, GoldenError } from '@/server/services/workshop/eda/golden'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  try {
    const ok = deleteGolden(user, id)
    if (!ok) throw new AppError(404, 'NOT_FOUND' as never, `golden 不存在: ${id}`)
    return { deleted: true }
  }
  catch (err) {
    if (err instanceof GoldenError) throw new AppError(err.status, err.code as never, err.message)
    throw err
  }
})
