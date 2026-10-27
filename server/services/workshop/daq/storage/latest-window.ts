/**
 * 实时窗口取数(tail)—— 从时序库取「窗口末尾」的 limit 个桶,仍按时间升序返回。
 *
 * 为什么不在适配器里改 query()/queryTagged() 的 ORDER BY:
 *   旧语义(limit = 窗口**最旧**段)是导出游标续页与 AML 训练集构建的既定契约
 *   (tests/tsdb-ordering.test.ts 锁定),不能为了实时面整体翻转。
 *
 * 算法(仅桶模式):
 *   ① 从窗口末尾向前以 span=桶宽×min(limit,512) 起步、×4 扩展,直到 [low,to] 内
 *      桶数 ≥ limit 或 low 触到 from —— **不从头扫全窗口**,`from` 缺省(如 UI 趋势)
 *      也不会退化成 epoch 级二分;
 *   ② 在 [low,to] 内做**桶对齐二分**,求最小 from*,使 [from*,to] 桶数 ≥ limit;
 *      终止精度 = 一个桶宽,因此 [from*,to] 至多比 limit 多 1 个桶;
 *   ③ 取 [from*,to] 的全部桶,`slice(-limit)` 即窗口末尾 limit 个(对稀疏空洞同样成立)。
 *   适配器对单次查询有 5000 行上限:limit 接近 5000 时再做一次 [from*+桶宽,to] 合并,
 *   避免"最旧 5000 行"吃掉最新桶。
 *
 * raw(无桶宽)不在这里反转语义:调用方(/samples、daq_query、EDA)都按桶查询;
 * raw 直接透传旧语义,避免为极少数调用引入 1ms 分辨率的二分。
 */
import type { DaqQueryOpts, TsdbPoint, TsdbPort, TsdbTagQuery } from './tsdb-port'

/** 桶宽下限(与适配器/服务端 clamp 同源:低于 100ms 视为 raw) */
const MIN_BUCKET_MS = 100
/** 适配器单次桶查询上限(query() 5000;queryTagged 1e6) */
const QUERY_MAX_ROWS = 5000
/** 扩展/二分步数上限(防病态配置死循环;正常数据 ~10 步内收敛) */
const MAX_EXPAND_STEPS = 24
const MAX_BISECT_STEPS = 32

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const n = Number(limit)
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? Math.round(n) : fallback, max))
}

/**
 * 对单节点取窗口末尾 limit 个桶。
 * @param fetch (fromMs, lim) => [fromMs,to] 的桶(升序);lim 为本次请求行数上限
 * @param fetchMax 该后端单次查询的行数硬上限(query()=5000, queryTagged=1e6)
 */
async function tailBuckets(
  fetch: (fromMs: number, lim: number) => Promise<TsdbPoint[]>,
  fromMs: number,
  toMs: number,
  bucketMs: number,
  limit: number,
  fetchMax: number,
): Promise<TsdbPoint[]> {
  if (toMs <= fromMs) return []
  const step = Math.max(MIN_BUCKET_MS, Math.round(bucketMs))
  const probeLim = Math.min(fetchMax, limit + 8)
  // ① 从末尾向前扩展:先看最后 ~min(limit,512) 个桶,不足再 ×4
  let span = step * Math.max(4, Math.min(limit, 512))
  let low = Math.max(fromMs, toMs - span)
  let pts = await fetch(low, probeLim)
  let expand = 0
  while (pts.length < limit && low > fromMs && expand++ < MAX_EXPAND_STEPS) {
    span *= 4
    low = Math.max(fromMs, toMs - span)
    pts = await fetch(low, probeLim)
  }
  // 整个 [from,to] 的桶数都不足 limit → 全量返回(稀疏窗口不丢历史段)
  if (pts.length < limit) return pts

  // ② 桶对齐二分:[lo,to] 桶数 ≥ limit,hi 窗口为空
  let lo = low
  let hi = toMs + 1
  let guard = 0
  while (hi - lo > step && guard++ < MAX_BISECT_STEPS) {
    const mid = Math.floor((lo + (hi - lo) / 2) / step) * step
    if (mid <= lo) break
    const p = await fetch(mid, limit)
    if (p.length >= limit) lo = mid
    else hi = mid
  }

  // ③ 取 [lo,to](至多 limit+1 个桶);若适配器上限截断了末尾,再合并 [lo+step,to]
  const tail = await fetch(lo, probeLim)
  if (tail.length <= limit) return tail
  if (tail.length < probeLim) return tail.slice(-limit) // 完整返回(limit+1 个桶),取末尾
  // 命中后端行数上限(多见于 limit 接近 5000):把更靠后的桶补进来后合并
  const rest = await fetch(Math.min(toMs, lo + step), probeLim)
  const merged = new Map<number, TsdbPoint>()
  for (const p of [...tail, ...rest]) merged.set(p.at, p)
  const all = [...merged.values()].sort((a, b) => a.at - b.at)
  return all.length > limit ? all.slice(-limit) : all
}

/** 单节点实时窗口查询(升序返回,末元素=窗口内最新样本)。 */
export async function queryLatest(tsdb: TsdbPort, nodeId: string, opts: DaqQueryOpts = {}): Promise<TsdbPoint[]> {
  const limit = clampLimit(opts.limit, 500, 5000)
  const to = opts.toMs ?? Date.now()
  const from = opts.fromMs ?? 0
  const bucket = Number(opts.bucketMs ?? 0)
  const base: DaqQueryOpts = { fromMs: from, toMs: to, bucketMs: opts.bucketMs, limit }
  if (bucket < MIN_BUCKET_MS) return tsdb.query(nodeId, base)
  return tailBuckets((fromMs, lim) => tsdb.query(nodeId, { ...base, fromMs, limit: lim }), from, to, bucket, limit, QUERY_MAX_ROWS)
}

/**
 * 跨通道实时窗口查询:tail 语义 = **每节点**各取末尾 limit 个桶。
 * 逐节点循环(带原始打标过滤条件),避免多节点共享一个 limit 时被单条长序列吃光。
 */
export async function queryTaggedLatest(tsdb: TsdbPort, q: TsdbTagQuery): Promise<Map<string, TsdbPoint[]>> {
  const out = new Map<string, TsdbPoint[]>()
  const limit = clampLimit(q.limit, 2000, 1_000_000)
  const to = q.toMs ?? Date.now()
  const from = q.fromMs ?? 0
  const bucket = Number(q.bucketMs ?? 0)
  const nodeIds = q.nodeIds ?? []
  if (nodeIds.length === 0) return tsdb.queryTagged({ ...q, limit })
  for (const nodeId of nodeIds) {
    const base: TsdbTagQuery = { ...q, nodeIds: [nodeId], fromMs: from, toMs: to, limit }
    if (bucket < MIN_BUCKET_MS) {
      const m = await tsdb.queryTagged(base)
      out.set(nodeId, m.get(nodeId) ?? [])
      continue
    }
    const pts = await tailBuckets(async (fromMs, lim) => {
      const m = await tsdb.queryTagged({ ...base, fromMs, limit: lim })
      return m.get(nodeId) ?? []
    }, from, to, bucket, limit, 1_000_000)
    out.set(nodeId, pts)
  }
  return out
}

/** 数据新鲜度描述(库内最新样本距 now 的秒数;供 Agent 输出与验收断言) */
export function freshnessOf(points: TsdbPoint[], now = Date.now()): { latestAt: number | null, ageMs: number | null } {
  const latestAt = points.length > 0 ? points[points.length - 1]!.at : null
  return { latestAt, ageMs: latestAt == null ? null : Math.max(0, now - latestAt) }
}
