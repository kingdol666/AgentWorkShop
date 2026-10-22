/**
 * GET /api/workshop/eda/golden/deviation?run_id=&node_id= —— 批次 vs golden 偏差分。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { deviationScore, GoldenError } from '@/server/services/workshop/eda/golden'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  try {
    const r = await deviationScore(user, { runId: String(q.run_id ?? ''), nodeId: String(q.node_id ?? '') })
    return r
  }
  catch (err) {
    if (err instanceof GoldenError) throw new AppError(err.status, err.code as never, err.message)
    throw err
  }
})
