/**
 * EDA 数据查询服务 —— 产线级多节点批量时序查询(plan1 /daq/query 的核心)。
 *
 * B1 收口方式:服务层**逐节点循环**调用 queryTagged(nodeIds:[单个]) —— 单节点查询时
 * 全局 LIMIT 与每节点配额语义等价,无需改动 TsdbPort 双适配器契约(2026-10-21:适配器
 * 侧 ROW_NUMBER 方案因安全扫描器对存量 $n 占位符体系的全文件基线拦截而放弃,逐节点
 * 循环是评审给出的备选②,正确性由构造保证)。
 *
 * 交互式护栏(eda-enterprise 评审 H2):
 *  - node_ids ≤ 8;省略时取产线全部节点,>8 即 400 要求显式指定;
 *  - 每节点返回点 ≤2000;桶宽自动抬高使 桶数/节点 ≤2000(窗口/2000);
 *  - 窗口 ≤7 天;单用户并发查询 ≤2(超出 429);
 *  - LRU 缓存 key=全部影响结果的入参(节点集+窗+桶+agg+打标过滤),TTL 按桶宽分档。
 */
import type { ResolvedUser } from '@/server/api/workshop/caller'
import { lineMode } from '../permissions'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { getDcwController } from '../dcw/dcw-controller'
import { getActiveLineRun } from '../dcw/line-run'

export const QUERY_NODES_MAX = 8
export const QUERY_POINTS_PER_NODE = 2000
const WINDOW_MAX_MS = 7 * 24 * 3600_000

export type QueryAgg = 'avg' | 'min' | 'max'

export interface DataQueryInput {
  lineId?: string
  nodeIds?: string[]
  fromMs?: number
  toMs?: number
  lastMinutes?: number
  bucketMs?: number
  agg?: QueryAgg
  runId?: string
  recipeId?: string
  productId?: string
  includeBand?: boolean
}

export interface DataQuerySeries {
  nodeId: string
  name: string
  unit: string
  lineId: string
  min: number | null
  max: number | null
  points: Array<{ at: number, v: number }>
  band?: Array<{ at: number, lo: number, hi: number }>
  truncated: boolean
}

export interface DataQueryResult {
  lineId: string
  window: { fromMs: number, toMs: number, bucketMs: number, agg: QueryAgg }
  series: DataQuerySeries[]
  cached: boolean
}

// ===== 并发闸(单用户 ≤2 在飞) =====
const inflight = new Map<string, number>()

export function dataQueryConcurrencyReset(): void {
  inflight.clear()
}

// ===== LRU 缓存(TTL 按桶宽分档) =====
interface CacheEntry {
  at: number
  result: DataQueryResult
}
const cache = new Map<string, CacheEntry>()
const CACHE_MAX = 100

function cacheTtl(bucketMs: number): number {
  return bucketMs >= 60_000 ? 60_000 : 5_000
}

export function dataQueryCacheClear(): void {
  cache.clear()
}

function cacheKey(inp: DataQueryInput & { resolvedNodeIds: string[] }): string {
  return JSON.stringify([
    inp.resolvedNodeIds, inp.fromMs, inp.toMs, inp.bucketMs, inp.agg,
    inp.lineId ?? '', inp.runId ?? '', inp.recipeId ?? '', inp.productId ?? '', inp.includeBand ?? false,
  ])
}

export class DataQueryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** 用户可读产线集合内的节点解析(越权/不存在/停用一律剔除;全不可见报 403) */
function resolveNodes(user: ResolvedUser, inp: DataQueryInput): { lineId: string, nodeIds: string[] } {
  const repo = getDaqNodeRepo()
  let lineId = String(inp.lineId ?? '').trim()
  if (lineId && lineMode(user, lineId) === 'none') {
    throw new DataQueryError(403, 'SCOPE_VIOLATION', `产线 ${lineId} 不在你的可读范围内。`)
  }
  const wanted = (inp.nodeIds ?? []).map(s => String(s).trim()).filter(Boolean)
  if (wanted.length > QUERY_NODES_MAX) {
    throw new DataQueryError(400, 'VALIDATION_ERROR', `node_ids 一次最多 ${QUERY_NODES_MAX} 个(收到 ${wanted.length});请分组查询或按产线过滤。`)
  }
  let nodes = wanted.map(id => repo.byId(id)).filter(n => n && n.enabled)
  if (wanted.length > 0 && nodes.length === 0) {
    throw new DataQueryError(403, 'SCOPE_VIOLATION', '指定的节点不存在、已停用或不在你的可读范围内。')
  }
  for (const n of nodes) {
    if (lineMode(user, n!.lineId) === 'none') {
      throw new DataQueryError(403, 'SCOPE_VIOLATION', `节点 ${n!.name}(${n!.id}) 不在你的可读产线上。`)
    }
    if (!lineId) lineId = n!.lineId ?? ''
  }
  if (wanted.length === 0) {
    if (!lineId) throw new DataQueryError(400, 'VALIDATION_ERROR', 'line_id 与 node_ids 至少提供一个。')
    nodes = repo.all().filter(n => n.lineId === lineId && n.enabled)
    if (nodes.length > QUERY_NODES_MAX) {
      throw new DataQueryError(400, 'VALIDATION_ERROR', `产线 ${lineId} 有 ${nodes.length} 个数采节点,一次最多查询 ${QUERY_NODES_MAX} 个:请传 node_ids 显式选择(≤${QUERY_NODES_MAX})。`)
    }
  }
  if (nodes.length === 0) throw new DataQueryError(400, 'VALIDATION_ERROR', '没有可查询的节点。')
  return { lineId, nodeIds: nodes.map(n => n!.id) }
}

/** 多节点批量查询(逐节点循环;护栏/缓存/并发闸在此收口) */
export async function dataQuery(user: ResolvedUser, inp: DataQueryInput): Promise<DataQueryResult> {
  const nInFlight = inflight.get(user.id) ?? 0
  if (nInFlight >= 2) {
    throw new DataQueryError(429, 'QUERY_CONCURRENCY', '你的查询并发已达上限(2),请等待在途查询完成。')
  }
  const toMs = Number(inp.toMs) || Date.now()
  const fromMs = Number(inp.fromMs) || toMs - (Number(inp.lastMinutes) || 60) * 60_000
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new DataQueryError(400, 'VALIDATION_ERROR', '时间窗非法:from 必须小于 to。')
  }
  if (toMs - fromMs > WINDOW_MAX_MS) {
    throw new DataQueryError(400, 'VALIDATION_ERROR', '时间窗超限(最大 7 天),请缩小窗口。')
  }
  const agg: QueryAgg = inp.agg === 'min' || inp.agg === 'max' ? inp.agg : 'avg'
  // 桶宽:显式请求与自动抬高中取大者,保证 桶数/节点 ≤2000(默认下限仍受 daq.query.minBucketMs 约束)
  const { minBucketMs } = (await import('../settings')).daqRuntimeSettings().query
  const autoBucket = Math.ceil((toMs - fromMs) / QUERY_POINTS_PER_NODE)
  const bucketMs = Math.max(minBucketMs, Math.round(Number(inp.bucketMs)) || 0, autoBucket)

  const { lineId, nodeIds } = resolveNodes(user, inp)
  const key = cacheKey({ ...inp, resolvedNodeIds: nodeIds, fromMs, toMs, bucketMs, agg })
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < cacheTtl(bucketMs)) {
    cache.delete(key)
    cache.set(key, hit)
    return { ...hit.result, cached: true }
  }

  inflight.set(user.id, nInFlight + 1)
  try {
    const { getTsdb, tsdbReady } = await import('../daq/storage')
    await tsdbReady
    const tsdb = getTsdb()
    const repo = getDaqNodeRepo()
    const series: DataQuerySeries[] = []
    for (const nodeId of nodeIds) {
      const node = repo.byId(nodeId)
      if (!node) continue
      const tagged = await tsdb.queryTagged({
        lineId: node.lineId || lineId || undefined,
        runId: inp.runId || undefined,
        recipeId: inp.recipeId || undefined,
        productId: inp.productId || undefined,
        nodeIds: [nodeId],
        fromMs,
        toMs,
        bucketMs,
        limit: QUERY_POINTS_PER_NODE,
      })
      const pts = tagged.get(nodeId) ?? []
      const points: DataQuerySeries['points'] = []
      let band: DataQuerySeries['band']
      for (const p of pts) {
        const v = agg === 'min' ? p.min : agg === 'max' ? p.max : p.avg
        if (!Number.isFinite(v)) continue
        points.push({ at: p.at, v: Number((v ?? 0).toFixed(6)) })
        if (inp.includeBand && p.min != null && p.max != null) {
          band ??= []
          band.push({ at: p.at, lo: Number(p.min.toFixed(6)), hi: Number(p.max.toFixed(6)) })
        }
      }
      series.push({
        nodeId,
        name: node.name,
        unit: node.unit ?? '',
        lineId: node.lineId ?? lineId,
        min: node.min ?? null,
        max: node.max ?? null,
        points,
        ...(band ? { band } : {}),
        truncated: pts.length >= QUERY_POINTS_PER_NODE,
      })
    }
    // 默认作用域提示(与 daq_query 工具同口径):无显式打标过滤且产线有活动批次 → 结果只含活动批次样本
    const result: DataQueryResult = {
      lineId,
      window: { fromMs, toMs, bucketMs, agg },
      series,
      cached: false,
    }
    cache.set(key, { at: Date.now(), result })
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    void inp
    return result
  }
  finally {
    inflight.set(user.id, Math.max(0, (inflight.get(user.id) ?? 1) - 1))
  }
}

/** 活动批次提示(前端时间选择器旁展示"当前查询默认限定活动批次") */
export function activeRunHintOf(lineId: string): { runId?: string, recipeId?: string } {
  const run = lineId ? getActiveLineRun(lineId) : null
  return run ? { runId: run.runId, recipeId: run.recipeId } : {}
}

/** 缓存与配方名联查(前端图例需要配方上下文时用) */
export function recipeNameOf(recipeId: string): string {
  return getDcwController().listRecipes().find(r => r.id === recipeId)?.name ?? recipeId
}
