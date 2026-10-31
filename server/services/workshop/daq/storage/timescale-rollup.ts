/**
 * TimescaleRollupStore —— 分层保留的"读/治理旁路"(与 TimescaleAdapter 共用同一库)。
 *
 * 职责:逐产线保留期覆写、1m/1h 聚合与水位、跨保留期历史查询、逐产线清理。
 * 独立成模块的原因:适配器是已投产的热路径(写入/分页/标签查询),本模块只承担
 * 历史数据治理,各自连接池、故障域隔离。
 *
 * 隔离模型:`line_id` 是 daq_samples 的查询/保留期维度;压缩 segmentby 含 line_id,
 * 产线数据在压缩段上物理分离;物理 chunk 级隔离见 deploy/timescale/002。
 */
import { Pool } from 'pg'
import type {
  TsdbHistoryQuery,
  TsdbHistoryResult,
  TsdbLayoutInfo,
  TsdbLineTableInfo,
  TsdbPoint,
  TsdbRetentionInfo,
  TsdbRetentionPatch,
  TsdbRollupResult,
} from './tsdb-port'
import {
  HOUR_ROLLUP_MS,
  MINUTE_ROLLUP_MS,
  mergeHistoryPoints,
  normalizeRetention,
  planHistoryQuery,
  rawCutoffMs,
  type RetentionPolicy,
} from './retention'

export interface RollupStoreOptions {
  retentionH: number
  frameRetentionH: number
  minuteRetentionH: number
  hourRetentionH: number
  enabled?: boolean
  lagMs?: number
  windowMs?: number
  maxWindowsPerRun?: number
  poolMax?: number
}

interface LinePolicyRow {
  raw: number | null
  minute: number | null
  hour: number | null
}

interface RollupStep {
  rows: number
  watermark: number
  pending: boolean
}

const SAMPLE_TABLE = 'daq_samples'
const ROLLUP_TABLE = 'daq_rollup'

export class TimescaleRollupStore {
  private pool: Pool | null = null
  private readonly defaultPolicy: RetentionPolicy
  private readonly rollup: { enabled: boolean, lagMs: number, windowMs: number, maxWindowsPerRun: number }
  private linePolicies = new Map<string, LinePolicyRow>()
  private knownLines = new Set<string>()
  private loaded = false

  constructor(private readonly url: string, private readonly options: RollupStoreOptions) {
    // 2026-10-30 加固(数据安全):保留期在此统一钳制 —— raw/minute ≥1h(0 会被
    // drop_chunks(older_than=>now())/全表 DELETE 当成"裁到此刻",清空全部历史);
    // hour 0 合法=永久,负值/非法归 0。配置层 zod/descriptor 也限 min(1),此处兜底。
    this.defaultPolicy = {
      rawRetentionH: Math.max(1, Math.round(Number(options.retentionH) || 720)),
      minuteRetentionH: Math.max(1, Math.round(Number(options.minuteRetentionH) || 8760)),
      hourRetentionH: Math.max(0, Math.round(Number(options.hourRetentionH) || 0)),
    }
    this.rollup = {
      enabled: options.enabled !== false,
      lagMs: Math.max(60_000, Number(options.lagMs ?? 300_000)),
      windowMs: Math.max(MINUTE_ROLLUP_MS, Number(options.windowMs ?? 3_600_000)),
      maxWindowsPerRun: Math.max(1, Math.min(512, Math.round(Number(options.maxWindowsPerRun ?? 24)))),
    }
  }

  async init(): Promise<void> {
    this.pool = new Pool({ connectionString: this.url, max: Math.max(1, Math.min(8, Number(this.options.poolMax ?? 4))) })
    await this.initSchema()
    await this.loadPolicies()
    await this.backfillLines()
    if (this.rollup.enabled) await this.sweepNow()
  }

  private async initSchema(): Promise<void> {
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS daq_line_storage (
        line_id text PRIMARY KEY, raw_retention_h integer, minute_retention_h integer,
        hour_retention_h integer, updated_at timestamptz NOT NULL DEFAULT now()
      );
    `)
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS daq_rollup_watermark (
        line_id text NOT NULL, res_ms integer NOT NULL, watermark_ms bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (line_id, res_ms)
      );
    `)
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS daq_rollup (
        line_id text NOT NULL, node_id text NOT NULL, ts timestamptz NOT NULL, res_ms integer NOT NULL,
        product_id text NOT NULL, recipe_id text NOT NULL, run_id text NOT NULL,
        avg double precision NOT NULL, min double precision NOT NULL, max double precision NOT NULL, cnt bigint NOT NULL,
        PRIMARY KEY (line_id, node_id, res_ms, ts, product_id, recipe_id, run_id)
      );
    `)
    await this.pool!.query(`SELECT create_hypertable('daq_rollup', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`).catch(() => {})
    await this.pool!.query(`CREATE INDEX IF NOT EXISTS idx_daq_rollup_node_res_ts ON daq_rollup (node_id, res_ms, ts DESC)`).catch(() => {})
    await this.pool!.query(`CREATE INDEX IF NOT EXISTS idx_daq_rollup_line_res_ts ON daq_rollup (line_id, res_ms, ts DESC)`).catch(() => {})
    await this.pool!.query(`CREATE INDEX IF NOT EXISTS idx_daq_samples_line_ts ON daq_samples (line_id, ts DESC)`).catch(() => {})
    await this.pool!.query(`ALTER TABLE daq_rollup SET (timescaledb.compress, timescaledb.compress_segmentby = 'line_id,node_id', timescaledb.compress_orderby = 'ts DESC')`).catch(() => {})
    await this.pool!.query(`SELECT add_compression_policy('daq_rollup', INTERVAL '1 day', if_not_exists => TRUE)`).catch(() => {})
  }

  private async loadPolicies(): Promise<void> {
    if (!this.pool) return
    const { rows } = await this.pool.query(
      `SELECT line_id, raw_retention_h, minute_retention_h, hour_retention_h FROM daq_line_storage`,
    ) as { rows: Array<{ line_id: string, raw_retention_h: number | null, minute_retention_h: number | null, hour_retention_h: number | null }> }
    this.linePolicies = new Map()
    this.knownLines = new Set()
    for (const r of rows) {
      const lineId = String(r.line_id ?? '')
      this.linePolicies.set(lineId, {
        raw: r.raw_retention_h == null ? null : Number(r.raw_retention_h),
        minute: r.minute_retention_h == null ? null : Number(r.minute_retention_h),
        hour: r.hour_retention_h == null ? null : Number(r.hour_retention_h),
      })
      if (lineId) this.knownLines.add(lineId)
    }
    this.loaded = true
  }

  private async backfillLines(): Promise<void> {
    try {
      await this.pool!.query(
        `INSERT INTO daq_line_storage (line_id)
         SELECT DISTINCT line_id FROM daq_samples WHERE line_id IS NOT NULL AND line_id <> ''
         ON CONFLICT (line_id) DO NOTHING`,
      )
      await this.loadPolicies()
    }
    catch { /* 库表尚未就绪/无权限:保留期覆写暂不可用,不影响采集 */ }
  }

  /**
   * 运行期产线发现(2026-10-30 修复):此前产线集合只在 init() 时 backfill 一次,
   * 运行期新建的产线(开线才有样本)不进 knownLines → 既不产 1m/1h 聚合,
   * 也不进逐线保留期裁剪名单(有任一覆写时旧 raw 永不回收)。
   * rollup/sweep 每轮先做一次幂等 INSERT DISTINCT,零样本新线零开销。
   */
  private async refreshKnownLines(): Promise<void> {
    await this.backfillLines()
  }

  private policyOf(lineId: string): RetentionPolicy {
    const row = this.linePolicies.get(lineId)
    return normalizeRetention({
      rawRetentionH: row?.raw ?? undefined,
      minuteRetentionH: row?.minute ?? undefined,
      hourRetentionH: row?.hour ?? undefined,
    }, this.defaultPolicy)
  }

  retentionInfo(): TsdbRetentionInfo {
    return {
      rawRetentionH: this.defaultPolicy.rawRetentionH,
      rollupEnabled: this.rollup.enabled,
      rollupResolutions: this.rollup.enabled ? [MINUTE_ROLLUP_MS, HOUR_ROLLUP_MS] : [],
    }
  }

  // ---------- 历史查询 ----------

  async queryHistory(nodeId: string, q: TsdbHistoryQuery): Promise<TsdbHistoryResult> {
    if (!this.pool) throw new Error('时序库未连接')
    if (!this.loaded) await this.loadPolicies()
    const toMs = Number(q.toMs)
    const fromMs = Number(q.fromMs)
    const limit = Math.max(1, Math.min(q.limit ?? 2000, 1_000_000))
    const now = Date.now()
    const policy = this.policyOf(q.lineId ?? '')
    const plan = planHistoryQuery({ fromMs, toMs, bucketMs: q.bucketMs, nowMs: now, policy, hasRollup: this.rollup.enabled })
    if (plan.source === 'raw' || plan.rollupResMs == null) {
      const points = await this.queryRaw(nodeId, fromMs, toMs, plan.bucketMs, limit)
      return {
        points, resolution: 'raw',
        coverage: {
          requestedFromMs: fromMs, requestedToMs: toMs,
          availableFromMs: points[0]?.at ?? null,
          rawFromMs: rawCutoffMs(now, policy.rawRetentionH),
          truncated: points.length >= limit,
          note: plan.note,
        },
      }
    }
    const rollupPoints = await this.queryRollup(nodeId, plan.rollupResMs, plan.rollupFromMs!, plan.rollupToMs!, plan.bucketMs, limit, q)
    const rawPoints = plan.mixed
      ? await this.queryRaw(nodeId, plan.rollupToMs ?? 0, toMs, plan.bucketMs, limit)
      : []
    const merged = mergeHistoryPoints(rollupPoints, rawPoints, limit)
    return {
      points: merged.points,
      resolution: plan.mixed ? 'mixed' : plan.source,
      coverage: {
        requestedFromMs: fromMs,
        requestedToMs: toMs,
        availableFromMs: await this.rollupMinTs(nodeId, plan.rollupResMs),
        rawFromMs: rawCutoffMs(now, policy.rawRetentionH),
        truncated: merged.truncated,
        note: plan.note + (merged.truncated ? ';结果超过 limit,已保留最新段' : ''),
      },
    }
  }

  private async queryRaw(nodeId: string, fromMs: number, toMs: number, bucketMs: number, limit: number): Promise<TsdbPoint[]> {
    // 2026-10-30 修复:DESC + JS 反转 —— ASC+LIMIT 在超窗时保留的是最旧段,
    // 与 mergeHistoryPoints「超限保留最新段」的契约相反,且 truncated 无法如实上报。
    const { rows } = await this.pool!.query(
      `SELECT time_bucket(make_interval(secs => $1::float8 / 1000.0), ts) AS b_at,
              avg(value)::double precision AS avg_v, min(value) AS min_v, max(value) AS max_v, count(*)::bigint AS cnt_v
       FROM daq_samples WHERE node_id = $2 AND ts >= $3 AND ts <= $4
       GROUP BY b_at ORDER BY b_at DESC LIMIT $5`,
      [Math.max(100, bucketMs), nodeId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), limit],
    ) as { rows: Array<{ b_at: string | Date, avg_v: number, min_v: number, max_v: number, cnt_v: string | number }> }
    return rows.reverse().map(r => ({ at: tsToMs(r.b_at), avg: Number(r.avg_v), min: Number(r.min_v), max: Number(r.max_v), cnt: Number(r.cnt_v) }))
  }

  private async queryRollup(
    nodeId: string,
    resMs: number,
    fromMs: number,
    toMs: number,
    bucketMs: number,
    limit: number,
    q: Pick<TsdbHistoryQuery, 'productId' | 'recipeId' | 'runId'>,
  ): Promise<TsdbPoint[]> {
    const { rows } = await this.pool!.query(
      `SELECT time_bucket(make_interval(secs => $1::float8 / 1000.0), ts) AS b_at,
              (sum(avg * cnt) / NULLIF(sum(cnt), 0))::double precision AS avg_v,
              min(min) AS min_v, max(max) AS max_v, sum(cnt)::bigint AS cnt_v
       FROM daq_rollup WHERE node_id = $2 AND res_ms = $3 AND ts >= $4 AND ts <= $5
         AND ($6::text = '' OR product_id = $6) AND ($7::text = '' OR recipe_id = $7) AND ($8::text = '' OR run_id = $8)
       GROUP BY b_at ORDER BY b_at DESC LIMIT $9`,
      [Math.max(100, bucketMs), nodeId, resMs, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), q.productId ?? '', q.recipeId ?? '', q.runId ?? '', limit],
    ) as { rows: Array<{ b_at: string | Date, avg_v: number, min_v: number, max_v: number, cnt_v: string | number }> }
    return rows.reverse().map(r => ({ at: tsToMs(r.b_at), avg: Number(r.avg_v), min: Number(r.min_v), max: Number(r.max_v), cnt: Number(r.cnt_v) }))
  }

  private async rollupMinTs(nodeId: string, resMs: number): Promise<number | null> {
    const { rows } = await this.pool!.query(
      'SELECT MIN(ts) AS t FROM daq_rollup WHERE node_id = $1 AND res_ms = $2',
      [nodeId, resMs],
    ) as { rows: Array<{ t: string | Date | null }> }
    const v = rows[0]?.t
    return v == null ? null : tsToMs(v)
  }

  // ---------- 聚合 ----------

  async runRollup(): Promise<TsdbRollupResult> {
    const result: TsdbRollupResult = { at: new Date().toISOString(), lines: 0, minuteRows: 0, hourRows: 0, notes: [] }
    if (!this.pool) return result
    if (!this.rollup.enabled) {
      result.notes.push('rollup 未启用')
      return result
    }
    if (!this.loaded) await this.loadPolicies()
    // 每轮先发现运行期新建产线(幂等;见 refreshKnownLines 注释)
    await this.refreshKnownLines()
    const minuteEnd = Math.floor((Date.now() - this.rollup.lagMs) / MINUTE_ROLLUP_MS) * MINUTE_ROLLUP_MS
    const hourEnd = Math.floor((Date.now() - this.rollup.lagMs) / HOUR_ROLLUP_MS) * HOUR_ROLLUP_MS
    for (const lineId of [...this.knownLines, '']) {
      result.lines++
      try {
        const m = await this.rollupStepMinute(lineId, minuteEnd)
        result.minuteRows += m.rows
        if (m.pending) result.notes.push(`${lineId || '(未分配)'}:1m 聚合未追平(下轮继续)`)
        const hourMax = Math.min(hourEnd, Math.floor(m.watermark / HOUR_ROLLUP_MS) * HOUR_ROLLUP_MS)
        if (hourMax > 0) {
          const h = await this.rollupStepHour(lineId, hourMax)
          result.hourRows += h.rows
        }
      }
      catch (err) {
        result.notes.push(`${lineId || '(未分配)'}:${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return result
  }

  /** 1m 聚合:从原始样本按 1 分钟桶 + 批次标签汇总 */
  private async rollupStepMinute(lineId: string, endMs: number): Promise<RollupStep> {
    return this.rollupWindows(lineId, MINUTE_ROLLUP_MS, endMs, async (from, to) => {
      const res = await this.pool!.query(
        `INSERT INTO daq_rollup (line_id, node_id, ts, res_ms, product_id, recipe_id, run_id, avg, min, max, cnt)
         SELECT COALESCE(line_id, ''), node_id, time_bucket(make_interval(secs => $1::float8 / 1000.0), ts), $2::integer,
                COALESCE(product_id, ''), COALESCE(recipe_id, ''), COALESCE(run_id, ''),
                avg(value)::double precision, min(value), max(value), count(*)::bigint
         FROM daq_samples WHERE COALESCE(line_id, '') = $3 AND ts >= $4 AND ts < $5
         GROUP BY 1, 2, 3, 4, 5, 6, 7 ON CONFLICT DO NOTHING`,
        [MINUTE_ROLLUP_MS, MINUTE_ROLLUP_MS, lineId, from, to],
      )
      return Number(res.rowCount ?? 0)
    }, () => this.minSampleTs(lineId))
  }

  /** 1h 聚合:从 1m 聚合行加权汇总(权重 = cnt) */
  private async rollupStepHour(lineId: string, endMs: number): Promise<RollupStep> {
    return this.rollupWindows(lineId, HOUR_ROLLUP_MS, endMs, async (from, to) => {
      const res = await this.pool!.query(
        `INSERT INTO daq_rollup (line_id, node_id, ts, res_ms, product_id, recipe_id, run_id, avg, min, max, cnt)
         SELECT line_id, node_id, time_bucket(make_interval(secs => $1::float8 / 1000.0), ts), $2::integer,
                product_id, recipe_id, run_id,
                (sum(avg * cnt) / NULLIF(sum(cnt), 0))::double precision, min(min), max(max), sum(cnt)::bigint
         FROM daq_rollup WHERE line_id = $3 AND res_ms = $4 AND ts >= $5 AND ts < $6
         GROUP BY 1, 2, 3, 4, 5, 6, 7 ON CONFLICT DO NOTHING`,
        [HOUR_ROLLUP_MS, HOUR_ROLLUP_MS, lineId, MINUTE_ROLLUP_MS, from, to],
      )
      return Number(res.rowCount ?? 0)
    }, () => this.minRollupTs(lineId, MINUTE_ROLLUP_MS))
  }

  /** 1h 聚合的起点:该线最早一条 1m 聚合行的 ts(2026-10-30 修复)。
   *  旧实现用当前分钟水位当起点 —— 水位行丢失/重建时,水位之前的 1m 历史永远
   *  不会被 1h 聚合(承诺的"1h 永久历史"出现空洞)。 */
  private async minRollupTs(lineId: string, resMs: number): Promise<number | null> {
    const { rows } = await this.pool!.query(
      `SELECT MIN(ts) AS t FROM daq_rollup WHERE line_id = $1 AND res_ms = $2`,
      [lineId, resMs],
    ) as { rows: Array<{ t: string | Date | null }> }
    const v = rows[0]?.t
    return v == null ? null : tsToMs(v)
  }

  /** 通用窗口推进(水位/幂等/单轮预算);insert 回调只负责一个稳定窗口的写入 */
  private async rollupWindows(
    lineId: string,
    resMs: number,
    endMs: number,
    insert: (fromIso: string, toIso: string) => Promise<number>,
    startOf: () => Promise<number | null>,
  ): Promise<RollupStep> {
    let wm = await this.watermarkGet(lineId, resMs)
    if (wm == null) {
      const start = await startOf()
      // 2026-10-30 修复:无任何样本 = 无活可干,不是"未追平" —— 旧语义让空线每轮
      // 都在 runRollup.notes 里刷「1m 聚合未追平」,把真滞后信号变成噪音。
      if (start == null) return { rows: 0, watermark: 0, pending: false }
      wm = Math.floor(start / resMs) * resMs
    }
    wm = Math.floor(wm / resMs) * resMs
    const maxEnd = Math.floor(endMs / resMs) * resMs
    const windowMs = Math.max(resMs, Math.floor(this.rollup.windowMs / resMs) * resMs)
    let rows = 0
    let windows = 0
    while (wm < maxEnd && windows < this.rollup.maxWindowsPerRun) {
      const next = Math.min(maxEnd, wm + windowMs)
      rows += await insert(new Date(wm).toISOString(), new Date(next).toISOString())
      wm = next
      await this.watermarkSet(lineId, resMs, wm)
      windows++
    }
    return { rows, watermark: wm, pending: wm < maxEnd }
  }

  private async minSampleTs(lineId: string): Promise<number | null> {
    const { rows } = await this.pool!.query(
      `SELECT MIN(ts) AS t FROM daq_samples WHERE COALESCE(line_id, '') = $1`,
      [lineId],
    ) as { rows: Array<{ t: string | Date | null }> }
    const v = rows[0]?.t
    return v == null ? null : tsToMs(v)
  }

  private async watermarkGet(lineId: string, resMs: number): Promise<number | null> {
    const { rows } = await this.pool!.query(
      `SELECT watermark_ms FROM daq_rollup_watermark WHERE line_id = $1 AND res_ms = $2`,
      [lineId, resMs],
    ) as { rows: Array<{ watermark_ms: string | number }> }
    const v = rows[0]?.watermark_ms
    return v == null ? null : Number(v)
  }

  private async watermarkSet(lineId: string, resMs: number, watermarkMs: number): Promise<void> {
    await this.pool!.query(
      `INSERT INTO daq_rollup_watermark (line_id, res_ms, watermark_ms, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (line_id, res_ms) DO UPDATE SET watermark_ms = EXCLUDED.watermark_ms, updated_at = now()`,
      [lineId, resMs, watermarkMs],
    )
  }

  // ---------- 清理 ----------

  async sweepNow(): Promise<void> {
    if (!this.pool) return
    if (!this.loaded) await this.loadPolicies()
    // 每轮先发现运行期新建产线:有覆写时逐线裁剪名单必须含新线,否则其旧 raw 永不回收
    await this.refreshKnownLines()
    const hasOverride = [...this.linePolicies.values()].some(r => (r.raw == null ? this.defaultPolicy.rawRetentionH : r.raw) !== this.defaultPolicy.rawRetentionH)
    if (hasOverride) {
      for (const lineId of this.knownLines) await this.pruneSamplesForLine(lineId, this.policyOf(lineId).rawRetentionH)
      await this.pruneUnassignedSamples(this.policyOf('').rawRetentionH)
    }
    else {
      // 无逐线覆写:走 chunk 级 drop(比逐行 DELETE 快,且与旧行为一致)
      await this.dropSamplesGlobal(this.defaultPolicy.rawRetentionH)
    }
    for (const lineId of [...this.knownLines, '']) {
      const p = this.policyOf(lineId)
      await this.pruneRollup(lineId, MINUTE_ROLLUP_MS, p.minuteRetentionH)
      if (p.hourRetentionH > 0) await this.pruneRollup(lineId, HOUR_ROLLUP_MS, p.hourRetentionH)
    }
  }

  /**
   * 2026-10-30 修复(契约兑现):原始样本只在「已被 1m 聚合覆盖」的范围内裁剪 ——
   * 裁剪上界 = min(保留期截止, 该线 1m 聚合水位)。模块契约是"超保留期的数据不删除,
   * 只是降分辨率保留";旧实现在聚合追平之前就按保留期删 raw(实例启动后 60s 首轮
   * sweep vs 聚合每轮最多推 24h),新部署接手历史库时,被删时代的数据永远不会有聚合。
   * 无水位(该线尚未聚合过)→ 本轮跳过裁剪,等聚合推进。
   */
  private async aggregatedCutoffMs(lineId: string, retentionH: number): Promise<number | null> {
    const retentionCutoff = Date.now() - retentionH * 3_600_000
    const wm = await this.watermarkGet(lineId, MINUTE_ROLLUP_MS)
    if (wm == null || wm <= 0) return null
    return Math.min(retentionCutoff, wm)
  }

  private async dropSamplesGlobal(retentionH: number): Promise<void> {
    try {
      // 全局 drop 同样受聚合水位钳制:取全部产线 1m 水位的最小值(最保守),
      // 无任何水位行(聚合从未跑过)→ 本轮不 drop。
      const { rows } = await this.pool!.query(
        `SELECT MIN(watermark_ms) AS wm FROM daq_rollup_watermark WHERE res_ms = $1`,
        [MINUTE_ROLLUP_MS],
      ) as { rows: Array<{ wm: string | number | null }> }
      const wm = rows[0]?.wm == null ? null : Number(rows[0].wm)
      if (wm == null || wm <= 0) return
      const cutoffMs = Math.min(Date.now() - retentionH * 3_600_000, wm)
      await this.pool!.query(
        `SELECT drop_chunks('daq_samples', older_than => $1::timestamptz)`,
        [new Date(cutoffMs).toISOString()],
      )
    }
    catch { /* 非 hypertable(扩展缺失)→ 静默 */ }
  }

  private async pruneSamplesForLine(lineId: string, retentionH: number): Promise<void> {
    const cutoffMs = await this.aggregatedCutoffMs(lineId, retentionH)
    if (cutoffMs == null) return
    await this.pruneSamplesRange(lineId, cutoffMs)
  }

  private async pruneUnassignedSamples(retentionH: number): Promise<void> {
    const cutoffMs = await this.aggregatedCutoffMs('', retentionH)
    if (cutoffMs == null) return
    await this.pruneSamplesRange('', cutoffMs)
  }

  /**
   * 2026-10-30 修复(真机实证,TimescaleDB 2.29.2):压缩 chunk 上
   * `DELETE ... ctid IN (SELECT ctid ...)` 必报
   * 「transparent decompression only supports tableoid system column」——
   * 透明解压只支持 tableoid,不支持 ctid 系统列。daq_samples/daq_rollup 都挂了
   * 1 天压缩策略(timescale.adapter.ts / 本文件 init),实例运行满 1 天后三个
   * prune* 每轮必炸 → 保留期清理整体失效、数据无限增长。此前契约测试没暴露:
   * 测试自建表未开压缩,与生产 DDL 偏离。
   * 普通 DELETE 走透明解压正常且 chunk 保持压缩(实测 DELETE 201 行后 is_compressed 仍 t);
   * 用 MIN(ts) 快进 + 7 天时间分片限制单语句规模,替代原 ctid 批删的分批意图。
   */
  private async pruneSamplesRange(lineId: string, cutoffMs: number): Promise<void> {
    const sliceMs = 7 * 24 * 3_600_000
    for (let guard = 0; guard < 2000; guard++) {
      const start = await this.minSampleTs(lineId)
      if (start == null || start >= cutoffMs) return
      const end = Math.min(start + sliceMs, cutoffMs)
      const res = await this.pool!.query(
        `DELETE FROM daq_samples WHERE COALESCE(line_id, '') = $1 AND ts >= $2::timestamptz AND ts < $3::timestamptz`,
        [lineId, new Date(start).toISOString(), new Date(end).toISOString()],
      )
      // MIN(ts) 到 DELETE 之间行被并发清走 → 本轮收工,剩余下轮 sweep 再收
      if (Number(res.rowCount ?? 0) === 0) return
    }
  }

  private async pruneRollup(lineId: string, resMs: number, retentionH: number): Promise<void> {
    const cutoffMs = Date.now() - retentionH * 3_600_000
    const sliceMs = 7 * 24 * 3_600_000
    for (let guard = 0; guard < 2000; guard++) {
      const start = await this.minRollupTs(lineId, resMs)
      if (start == null || start >= cutoffMs) return
      const end = Math.min(start + sliceMs, cutoffMs)
      const res = await this.pool!.query(
        `DELETE FROM daq_rollup WHERE line_id = $1 AND res_ms = $2 AND ts >= $3::timestamptz AND ts < $4::timestamptz`,
        [lineId, resMs, new Date(start).toISOString(), new Date(end).toISOString()],
      )
      if (Number(res.rowCount ?? 0) === 0) return
    }
  }

  // ---------- 运维 ----------

  async setLineRetention(lineId: string, patch: TsdbRetentionPatch): Promise<void> {
    if (!this.pool) throw new Error('时序库未连接')
    const key = String(lineId ?? '').trim()
    if (!this.loaded) await this.loadPolicies()
    // 2026-10-30 修复(数据安全):存储语义改为「未提供(undefined)=保持现值;显式 null=重置回全局」。
    // 旧实现把 patch 原样落库(undefined 与 null 一并写 NULL),部分更新(如只改 hour)会把
    // 既有 raw 覆写抹掉 → 下一轮 sweep 按全局 720h 裁剪,长保留数据被永久删除。
    // 且内存 next(合并值)与 DB 不一致,直到下次 loadPolicies 才暴露。
    const stored = this.linePolicies.get(key) ?? { raw: null, minute: null, hour: null }
    const storedRaw = patch.rawRetentionH === undefined ? stored.raw : patch.rawRetentionH
    const storedMinute = patch.minuteRetentionH === undefined ? stored.minute : patch.minuteRetentionH
    const storedHour = patch.hourRetentionH === undefined ? stored.hour : patch.hourRetentionH
    const next = normalizeRetention({
      rawRetentionH: storedRaw ?? undefined,
      minuteRetentionH: storedMinute ?? undefined,
      hourRetentionH: storedHour ?? undefined,
    }, this.defaultPolicy)
    await this.pool.query(
      `INSERT INTO daq_line_storage (line_id, raw_retention_h, minute_retention_h, hour_retention_h, updated_at)
       VALUES ($1, $2, $3, $4, now()) ON CONFLICT (line_id) DO UPDATE SET raw_retention_h = EXCLUDED.raw_retention_h,
       minute_retention_h = EXCLUDED.minute_retention_h, hour_retention_h = EXCLUDED.hour_retention_h, updated_at = now()`,
      [key, storedRaw, storedMinute, storedHour],
    )
    this.linePolicies.set(key, { raw: storedRaw, minute: storedMinute, hour: storedHour })
    if (key) this.knownLines.add(key)
    void next
  }

  async layoutInfo(): Promise<TsdbLayoutInfo> {
    if (!this.pool) throw new Error('时序库未连接')
    if (!this.loaded) await this.loadPolicies()
    const stat = await this.tableStat(SAMPLE_TABLE)
    const lines: TsdbLineTableInfo[] = []
    for (const lineId of this.knownLines) {
      const p = this.policyOf(lineId)
      lines.push({
        lineId,
        samplesTable: SAMPLE_TABLE,
        framesTable: 'daq_frames',
        rollupTable: ROLLUP_TABLE,
        rawRetentionH: p.rawRetentionH,
        minuteRetentionH: p.minuteRetentionH,
        hourRetentionH: p.hourRetentionH,
        rows: null,
        bytes: null,
      })
    }
    const wm = await this.pool.query('SELECT line_id, res_ms, watermark_ms FROM daq_rollup_watermark') as { rows: Array<{ line_id: string, res_ms: number, watermark_ms: string | number }> }
    const watermarks: Record<string, number> = {}
    for (const r of wm.rows) watermarks[`${String(r.line_id)}|${Number(r.res_ms)}`] = Number(r.watermark_ms)
    return {
      backend: 'timescale',
      layout: 'single',
      rawRetentionH: this.defaultPolicy.rawRetentionH,
      frameRetentionH: this.options.frameRetentionH,
      rollup: {
        enabled: this.rollup.enabled,
        minuteRetentionH: this.defaultPolicy.minuteRetentionH,
        hourRetentionH: this.defaultPolicy.hourRetentionH,
        watermarks,
      },
      lines,
      legacy: { table: SAMPLE_TABLE, rows: stat.rows, bytes: stat.bytes, migrated: true },
    }
  }

  private async tableStat(table: string): Promise<{ rows: number | null, bytes: number | null }> {
    try {
      const { rows } = await this.pool!.query(
        'SELECT reltuples::bigint AS rows, pg_total_relation_size(to_regclass($1)) AS bytes FROM pg_class WHERE oid = to_regclass($1)',
        [table],
      ) as { rows: Array<{ rows: string | number, bytes: string | number }> }
      const r = rows[0]
      return r ? { rows: Number(r.rows), bytes: Number(r.bytes) } : { rows: null, bytes: null }
    }
    catch {
      return { rows: null, bytes: null }
    }
  }

  async close(): Promise<void> {
    await this.pool?.end().catch(() => {})
    this.pool = null
  }
}

function tsToMs(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return Date.parse(String(v))
}
