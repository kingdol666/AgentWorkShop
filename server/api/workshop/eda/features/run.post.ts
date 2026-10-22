/**
 * POST /api/workshop/eda/features/run —— 手动重算一次批次的特征
 * (body: {run_id, grace_ms?};关账钩子之外的运维/测试入口;产线可读即可)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { lineMode } from '@/server/services/workshop/permissions'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { computeRunFeatures } from '@/server/services/workshop/eda/features'
import { edaRunById } from '@/server/services/workshop/eda/eda-run.repo'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ run_id?: string, grace_ms?: number | string }>(event) ?? {}
  const runId = String(body.run_id ?? '').trim()
  const run = edaRunById(runId)
  if (!run) throw new AppError(404, 'NOT_FOUND' as never, `批次不存在: ${runId}`)
  if (lineMode(user, run.lineId) === 'none') throw new AppError(403, 'SCOPE_VIOLATION' as never, '批次不在你的可读产线上。')
  try {
    const features = await computeRunFeatures(runId, { graceMs: Number(body.grace_ms) || 0 })
    return { runId, features }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new AppError(400, 'VALIDATION_ERROR' as never, msg)
  }
})
