/**
 * PATCH /api/workshop/eda/runs/:id/labels —— 批次标签(E8③:lot/wafer/operator 等 KV)。
 * body: { labels: Record<string,unknown> }(整体覆盖;GET /eda/runs?label=key:value 检索)。
 */
import { getRouterParam, readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { setRunLabels, edaRunById } from '@/server/services/workshop/eda/eda-run.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  const run = edaRunById(id)
  if (!run) throw new AppError(404, 'NOT_FOUND' as never, `批次不存在: ${id}`)
  // 标注=产线数据治理动作,需可操控(admin/editor/授权 operate 用户)
  if (lineMode(user, run.lineId) !== 'operate') {
    throw new AppError(403, 'SCOPE_VIOLATION' as never, '批次标签需产线可操控权限。')
  }
  const body = await readBody<{ labels?: Record<string, unknown> }>(event) ?? {}
  const labels = body.labels ?? {}
  setRunLabels(id, labels)
  return { run: edaRunById(id) }
})
