/**
 * 分层保留 + 历史查询路由(纯函数,可单测)。
 *
 * 生产语义:
 *  - 原始样本(raw)保留 `rawRetentionH`(默认 30 天,按产线可覆写);
 *  - 1 分钟聚合(rollup 60s)保留 `minuteRetentionH`(默认 1 年);
 *  - 1 小时聚合(rollup 3600s)默认**永久保留**(0 = 不清理)。
 *  → 超过原始保留期的数据不是"被删掉",而是以更低分辨率继续可查;
 *    真正决定"哪些还能查"的是 `planHistoryQuery()` 的返回,而不是静默返回空数组。
 *
 * 为什么不是 Timescale 的 continuous aggregate:
 *  按产线动态建表意味着每条线都要建 CAGG + refresh policy(关系数×3),
 *  且 CAGG 压缩/刷新能力随 Timescale 版本漂移。这里用应用侧幂等 rollup
 *  (`ON CONFLICT DO NOTHING` + 水位),两后端同构、可回放、可单测,
 *  代价是聚合窗口滞后一个 `lagMs`(默认 5 分钟,远大于采集乱序窗口)。
 */

export const MINUTE_ROLLUP_MS = 60_000
export const HOUR_ROLLUP_MS = 3_600_000
/** 保留期硬上限(10 年;0 仅对 hourRetentionH 合法 = 永久) */
export const RETENTION_MAX_H = 87_600

export interface RetentionPolicy {
  /** 原始样本保留小时数(≥1) */
  rawRetentionH: number
  /** 1 分钟聚合保留小时数(≥1) */
  minuteRetentionH: number
  /** 1 小时聚合保留小时数(0 = 永久) */
  hourRetentionH: number
}

export function clampRetentionH(v: unknown, dflt: number, allowZero = false): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  if (allowZero && n === 0) return 0
  return Math.max(1, Math.min(Math.round(n), RETENTION_MAX_H))
}

export function normalizeRetention(patch: Partial<RetentionPolicy> | null | undefined, base: RetentionPolicy): RetentionPolicy {
  const p = patch ?? {}
  return {
    rawRetentionH: clampRetentionH(p.rawRetentionH, base.rawRetentionH),
    minuteRetentionH: clampRetentionH(p.minuteRetentionH, base.minuteRetentionH),
    hourRetentionH: clampRetentionH(p.hourRetentionH, base.hourRetentionH, true),
  }
}

export function rawCutoffMs(nowMs: number, rawRetentionH: number): number {
  return nowMs - Math.max(1, rawRetentionH) * 3_600_000
}

/** 某分辨率最早可查时刻(null = 永久) */
export function retentionCutoffMs(nowMs: number, retentionH: number): number | null {
  return retentionH > 0 ? nowMs - retentionH * 3_600_000 : null
}

export interface HistoryPlanInput {
  fromMs: number
  toMs: number
  bucketMs: number
  nowMs: number
  policy: Pick<RetentionPolicy, 'rawRetentionH' | 'hourRetentionH'>
  /** 回滚聚合是否可用(Timescale per-line 且 rollup 已建表) */
  hasRollup: boolean
}

export interface HistoryPlan {
  /** 主体数据源 */
  source: 'raw' | 'minute' | 'hour'
  /** 窗口跨越原始保留边界:老段走 rollup、新段走 raw */
  mixed: boolean
  /** 选中的聚合分辨率(ms);raw 时为 null */
  rollupResMs: number | null
  /** rollup 段覆盖 [rollupFromMs, rollupToMs) */
  rollupFromMs: number | null
  rollupToMs: number | null
  /** 实际生效的桶宽(≥100ms) */
  bucketMs: number
  /** 给调用方/Actor 的可见说明(不得静默降级) */
  note: string
}

/**
 * 历史查询路由:
 *  - 桶宽 < 1min 或窗口完全在原始保留期内 → raw(精确);
 *  - 窗口早于原始保留期 → 走 rollup;桶宽 ≥1h 优先 1h 聚合,否则 1m;
 *  - 跨边界 → mixed(老段 rollup、新段 raw,按桶起点合并,raw 优先)。
 */
export function planHistoryQuery(input: HistoryPlanInput): HistoryPlan {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now()
  const bucketMs = Math.max(100, Math.round(Number(input.bucketMs) || 0) || MINUTE_ROLLUP_MS)
  const fromMs = Math.min(Number(input.fromMs), Number(input.toMs))
  const toMs = Math.max(Number(input.fromMs), Number(input.toMs))
  const rawFrom = rawCutoffMs(nowMs, input.policy.rawRetentionH)
  const rawOnly: HistoryPlan = {
    source: 'raw',
    mixed: false,
    rollupResMs: null,
    rollupFromMs: null,
    rollupToMs: null,
    bucketMs,
    note: '原始样本窗口',
  }
  if (!input.hasRollup || bucketMs < MINUTE_ROLLUP_MS || fromMs >= rawFrom) return rawOnly

  // 0 = 永久保留;>0 时只有窗口落在小时聚合保留期内才选它(否则 1m 仍有更细数据)
  const hourAvailable = input.policy.hourRetentionH === 0
    || fromMs >= nowMs - input.policy.hourRetentionH * 3_600_000
  const useHour = bucketMs >= HOUR_ROLLUP_MS && hourAvailable
  const res = useHour ? HOUR_ROLLUP_MS : MINUTE_ROLLUP_MS
  const mixed = toMs > rawFrom
  const label = useHour ? '1 小时聚合' : '1 分钟聚合'
  return {
    source: useHour ? 'hour' : 'minute',
    mixed,
    rollupResMs: res,
    rollupFromMs: fromMs,
    rollupToMs: mixed ? rawFrom : toMs,
    bucketMs,
    note: mixed
      ? `窗口跨越原始样本保留边界:${new Date(rawFrom).toISOString()} 之前用 ${label},之后用原始样本`
      : `窗口早于原始样本保留期,使用 ${label}历史数据(降采样分辨率 ${res}ms)`,
  }
}

/**
 * 合并 rollup 段与 raw 段:按桶起点升序,同 `at` 以 raw 为准
 * (raw 是精确值,rollup 只是聚合近似);超过 limit 时保留**最新**的 limit 个并标记截断。
 */
export function mergeHistoryPoints(
  rollupPoints: Array<{ at: number, avg?: number, min?: number, max?: number, cnt?: number, value?: number }>,
  rawPoints: Array<{ at: number, avg?: number, min?: number, max?: number, cnt?: number, value?: number }>,
  limit: number,
): { points: Array<{ at: number, avg?: number, min?: number, max?: number, cnt?: number, value?: number }>, truncated: boolean } {
  const byAt = new Map<number, { at: number, avg?: number, min?: number, max?: number, cnt?: number, value?: number }>()
  for (const p of rollupPoints) byAt.set(p.at, p)
  for (const p of rawPoints) byAt.set(p.at, p)
  const all = [...byAt.values()].sort((a, b) => a.at - b.at)
  const cap = Math.max(1, Math.round(limit) || all.length)
  if (all.length <= cap) return { points: all, truncated: false }
  return { points: all.slice(all.length - cap), truncated: true }
}
