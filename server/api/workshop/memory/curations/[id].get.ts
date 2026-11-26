/**
 * GET /api/workshop/memory/curations/:id —— 文档来源 + 运行历史（批次 E）。
 */
import { getRouterParam } from 'h3'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { getAmlRuntime } from '@/server/services/workshop/aml/runtime'
import { curationDetail } from '@/server/services/workshop/memory/curator'
import { assertMemoryWritable, requireMemoryUser } from '@/server/services/workshop/memory/memory-access'

export default defineApiHandler(async (event) => {
  const { user } = requireMemoryUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw new AppError(422, 'ID_REQUIRED', 'id 必填')
  assertMemoryWritable(user, id)
  const detail = curationDetail(getAmlRuntime().db, id)
  if (!detail) throw new AppError(404, 'NOT_FOUND', '汇整文档不存在')
  return detail
})
