/**
 * POST /api/workshop/eda/derived —— 创建派生数据集(M3 自动数据处理落点)。
 * body: { title?, line_id?, node_ids[], from, to, bucket_ms?, agg?, ops:[{kind,window?,period?}] }
 * 产物 CSV/manifest 经 GET /api/workshop/daq/export-file?job=<jobId>&path=data.csv 下载。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { createDerivedDataset, DERIVED_OPS, type DerivedOp } from '@/server/services/workshop/eda/derived'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const nodeIds = Array.isArray(body.node_ids) ? body.node_ids.map(String) : String(body.node_ids ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!nodeIds.length) throw new AppError(400, 'VALIDATION_ERROR' as never, 'node_ids 必填。')
  const toMs = Number(body.to) || Date.now()
  const fromMs = Number(body.from) || toMs - 3600_000
  const ops = (Array.isArray(body.ops) ? body.ops : []) as DerivedOp[]
  for (const o of ops) {
    if (!DERIVED_OPS.includes(o.kind as never)) {
      throw new AppError(400, 'VALIDATION_ERROR' as never, `算子 ${String(o.kind)} 不在白名单(${DERIVED_OPS.join('/')})。`)
    }
  }
  try {
    const r = await createDerivedDataset(user, {
      lineId: body.line_id ? String(body.line_id) : undefined,
      nodeIds,
      fromMs,
      toMs,
      bucketMs: body.bucket_ms == null ? undefined : Number(body.bucket_ms),
      agg: body.agg === 'min' || body.agg === 'max' ? body.agg : 'avg',
      ops,
    }, String(body.title ?? `派生集 ${new Date().toISOString().slice(0, 16)}`))
    return r
  }
  catch (err) {
    const e = err as { status?: number, message?: string }
    throw new AppError(e.status ?? 400, 'VALIDATION_ERROR' as never, e.message ?? '派生失败')
  }
})
