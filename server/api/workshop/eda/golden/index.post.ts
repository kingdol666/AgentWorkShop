/**
 * POST /api/workshop/eda/golden —— 从 good 批次生成 golden 参考轨迹。
 * body: { run_id, node_id, n_bins? }(批次须已关账且 outcome=good)
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { buildGolden, GoldenError } from '@/server/services/workshop/eda/golden'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{ run_id?: string, node_id?: string, n_bins?: number | string }>(event) ?? {}
  if (!String(body.run_id ?? '').trim() || !String(body.node_id ?? '').trim()) {
    throw new AppError(400, 'VALIDATION_ERROR' as never, 'run_id 与 node_id 必填。')
  }
  try {
    const golden = await buildGolden(user, {
      runId: String(body.run_id),
      nodeId: String(body.node_id),
      nBins: body.n_bins == null ? undefined : Number(body.n_bins),
    })
    return { golden }
  }
  catch (err) {
    if (err instanceof GoldenError) throw new AppError(err.status, err.code as never, err.message)
    throw err
  }
})
