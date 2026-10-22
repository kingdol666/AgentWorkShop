/**
 * GET /api/workshop/daq/query —— 产线级多节点批量时序查询(数据管理台核心端点)。
 *
 * query: line_id? node_ids?(逗号分隔,≤8) from/to(epoch ms) 或 last_minutes;
 *        bucket_ms?(自动抬升保证 桶数/节点 ≤2000) agg?(avg|min|max,缺省 avg)
 *        run_id?/recipe_id?/product_id?(打标过滤) include_band?(1=min/max 包络)
 * 权限:节点/产线 readonly 及以上;并发 ≤2/用户;TTL 缓存按桶宽分档。
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { dataQuery, DataQueryError, activeRunHintOf } from '@/server/services/workshop/eda/data-query'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = getQuery(event)
  const num = (k: string): number | undefined => (q[k] != null && String(q[k]).trim() !== '' && !Number.isNaN(Number(q[k])) ? Number(q[k]) : undefined)
  try {
    const result = await dataQuery(user, {
      lineId: q.line_id ? String(q.line_id) : undefined,
      nodeIds: q.node_ids ? String(q.node_ids).split(',').map(s => s.trim()).filter(Boolean) : undefined,
      fromMs: num('from'),
      toMs: num('to'),
      lastMinutes: num('last_minutes'),
      bucketMs: num('bucket_ms'),
      agg: q.agg === 'min' || q.agg === 'max' ? q.agg : 'avg',
      runId: q.run_id ? String(q.run_id) : undefined,
      recipeId: q.recipe_id ? String(q.recipe_id) : undefined,
      productId: q.product_id ? String(q.product_id) : undefined,
      includeBand: String(q.include_band ?? '') === '1',
    })
    return { ...result, activeRun: activeRunHintOf(result.lineId) }
  }
  catch (err) {
    if (err instanceof DataQueryError) {
      throw new AppError(err.status, err.code as never, err.message)
    }
    throw err
  }
})
