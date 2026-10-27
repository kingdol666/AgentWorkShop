/**
 * 实时窗口取数(tail)—— 从时序库取「窗口末尾」的 limit 个桶,仍按时间升序返回。
 *
 * 为什么不在适配器里改 query()/queryTagged() 的 ORDER BY:
 *   旧语义(limit = 窗口**最旧**段)是导出游标续页与 AML 训练集构建的既定契约
 *   (tests/tsdb-ordering.test.ts 锁定),不能为了实时面整体翻转。
 *
 * 算法(仅桶模式):
 *   ① 先按旧语义查一次;桶数 < limit → 窗口未被截断,原样返回(稀疏/小窗口零额外查询)。
 *   ② 窗口被截断 → 二分出最小的 from*,使 [from*, to] 内桶数 ≥ limit:
 *      - 桶数是 from 的单调不增函数,二分 ~log2(窗口/桶宽) 次(30 分钟/15s ≈ 8 次);
 *      - 最后再向前多取一个桶宽并 slice(-limit) —— 得到的就是窗口末尾 limit 个桶,
 *        且对稀疏数据(桶间有空洞)同样成立。
 *   数据量上限:每次查询最多 limit 行;实时面 limit ≤ 5000。
 *
 * raw(无桶宽)不在这里反转语义:调用方(/samples、daq_query、EDA)都按桶查询;
 * raw 直接透传旧语义,避免为极少数调用引入 1ms 分辨率的二分。
 */
import type { DaqQueryOpts, TsdbPoint, TsdbPort, TsdbTagQuery } from './tsdb-port'

/** 桶宽下限(与适配器/服务端 clamp 同源:低于 100ms 视为 raw) */
const MIN_BUCKET_MS = 100
/** 二分终止精度:一个桶宽(时间轴对齐由桶边界保证) */
const MAX_BISECT_STEPS = 24

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const n = Number(limit)
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? Math.round(n) : fallback, max))
}

/**
 * 对单节点取窗口末尾 limit 个桶。
 * @param fetch 给定 fromMs 与条数上限,返回 [fromMs, to] 的桶(升序)
 */
async function tailBuckets(
  fetch: (fromMs: number, lim: number) => Promise<TsdbPoint[]>,
  fromMs: number,
  toMs: number,
  bucketMs: number,
  limit: number,
): Promise<TsdbPoint[]> {
  const first = await fetch(fromMs, limit)
  if (first.length < limit) return first
  // 不变量:[lo,to] 桶数 ≥ limit;hi 窗口为空(hi=to+1 → from>to)
  let lo = fromMs
  let hi = toMs + 1
  const step = Math.max(MIN_BUCKET_MS, Math.round(bucketMs))
  let guard = 0
  while (hi - lo > step && guard++ < MAX_BISECT_STEPS) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const pts = await fetch(mid, limit)
    if (pts.length >= limit) lo = mid
    else hi = mid
  }
  // 多取一个桶宽消除边界误差;最后一次查询放宽 limit(覆盖边界附近多出的 1-3 个桶),
  // 否则窗口内桶数 > limit 时仍只会拿到最旧 limit 个。
  const finalFrom = Math.max(fromMs, lo - step)
  const finalLimit = Math.min(5000, limit + 8)
  const finalPts = finalFrom === fromMs ? await fetch(fromMs, finalLimit) : await fetch(finalFrom, finalLimit)
  return finalPts.length > limit ? finalPts.slice(-limit) : finalPts
}

/** 单节点实时窗口查询(升序返回,末元素=窗口内最新样本)。 */
export async function queryLatest(tsdb: TsdbPort, nodeId: string, opts: DaqQueryOpts = {}): Promise<TsdbPoint[]> {
  const limit = clampLimit(opts.limit, 500, 5000)
  const to = opts.toMs ?? Date.now()
  const from = opts.fromMs ?? 0
  const bucket = Number(opts.bucketMs ?? 0)
  const base: DaqQueryOpts = { fromMs: from, toMs: to, bucketMs: opts.bucketMs, limit }
  if (bucket < MIN_BUCKET_MS) return tsdb.query(nodeId, base)
  return tailBuckets((fromMs, lim) => tsdb.query(nodeId, { ...base, fromMs, limit: lim }), from, to, bucket, limit)
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
    }, from, to, bucket, limit)
    out.set(nodeId, pts)
  }
  return out
}

/** 数据新鲜度描述(库内最新样本距 now 的秒数;供 Agent 输出与验收断言) */
export function freshnessOf(points: TsdbPoint[], now = Date.now()): { latestAt: number | null, ageMs: number | null } {
  const latestAt = points.length > 0 ? points[points.length - 1]!.at : null
  return { latestAt, ageMs: latestAt == null ? null : Math.max(0, now - latestAt) }
}
