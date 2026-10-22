/**
 * GET /api/workshop/daq/export/:id —— 导出任务详情(ready 后带产物清单;目录被保留
 * 策略清理时 result.missing=true 如实呈现)。
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { getExportJobFor } from '@/server/services/workshop/eda/data-export'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const job = getExportJobFor(user, id)
  if (!job) throw new AppError(404, ErrorCodes.NOT_FOUND, `导出任务不存在或不可见: ${id}`)
  return { job }
})
