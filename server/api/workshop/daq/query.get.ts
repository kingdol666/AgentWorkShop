/**
 * GET /api/workshop/daq/query —— 产线级多节点批量时序查询(数据管理台核心端点)。
 *
 * query: line_id? node_ids?(逗号分隔,≤8) from/to(epoch ms) 或 last_minutes;
 *        bucket_ms?(自动抬升保证 桶数/节点 ≤2000) agg?(avg|min|max,缺省 avg)
 *        run_id?/recipe_id?/product_id?(打标过滤) include_band?(1=min/max 包络)
 * 权限:节点/产线 readonly 及以上;并发 ≤2/用户;TTL 缓存按桶宽分档。
 *
 * 2026-11-09: query 形状收敛到 zod。此前 num() 手工转型把 Number('abc')=NaN 静默当作
 * undefined —— 坏参数退化成"默认全窗查询";现在非法数值 400 精确到字段。
 * 空串仍按「未提供」处理(前端表单清空会发空串),语义不变。
 */
import { getValidatedQuery } from 'h3'
import { z } from 'zod'
import { resolveUser } from '@/server/api/workshop/caller'
import { zValidator } from '@/server/utils/validate'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { dataQuery, DataQueryError, activeRunHintOf } from '@/server/services/workshop/eda/data-query'

/** 数值型 query 参数:空串放行(未提供),其余必须可解析为有限数值 */
const numStr = z.string().optional().refine(
  v => v === undefined || v.trim() === '' || Number.isFinite(Number(v)),
  { message: '必须是数值' },
)

const schema = z.object({
  line_id: z.string().optional(),
  node_ids: z.string().optional(),
  from: numStr,
  to: numStr,
  last_minutes: numStr,
  bucket_ms: numStr,
  agg: z.enum(['avg', 'min', 'max']).optional(),
  run_id: z.string().optional(),
  recipe_id: z.string().optional(),
  product_id: z.string().optional(),
  include_band: z.string().optional(),
})

const numOf = (v: string | undefined): number | undefined => (v === undefined || v.trim() === '' ? undefined : Number(v))
const strOf = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v)

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const q = await getValidatedQuery(event, zValidator(schema))
  try {
    const result = await dataQuery(user, {
      lineId: strOf(q.line_id),
      nodeIds: strOf(q.node_ids)?.split(',').map(s => s.trim()).filter(Boolean),
      fromMs: numOf(q.from),
      toMs: numOf(q.to),
      lastMinutes: numOf(q.last_minutes),
      bucketMs: numOf(q.bucket_ms),
      agg: q.agg ?? 'avg',
      runId: strOf(q.run_id),
      recipeId: strOf(q.recipe_id),
      productId: strOf(q.product_id),
      includeBand: q.include_band === '1',
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
