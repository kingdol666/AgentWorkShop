/**
 * TimescaleAdapter —— 生产级 TimescaleDB 实现(端口契约见 tsdb-port)。
 *
 * 由 DAQ_TSDB_URL(postgres://user:pass@host:5432/db)启用。首次 init 幂等建表
 * 并调用 create_hypertable(ts 列,chunk 按天);写走参数化批量 INSERT,
 * 读按 time_bucket 降采样(Timescale 原生函数)。连接失败由工厂捕获降级仿真库。
 */
import { createRequire } from 'node:module'
import type { Pool } from 'pg'
import type { DaqQueryOpts, DaqSampleRow, TsdbPoint, TsdbPort } from './tsdb-port'
import { daqRuntimeSettings } from '../../settings'

/* nitro(Windows)dev 下对 external 的动态 import 会生成绝对盘符路径 → ESM loader
 * 拒绝 'd:' scheme;用 createRequire 走 CJS require 由 Node 原生解析(生产亦同)。 */
const requirePg = createRequire(import.meta.url)

export class TimescaleAdapter implements TsdbPort {
  readonly backend = 'timescale'
  private pool: Pool | null = null
  private retentionTimer: NodeJS.Timeout | null = null
  /** 保留期(daq.tsRetentionH;env DAQ_TS_RETENTION_H 兼容) */
  private readonly retentionH = daqRuntimeSettings().tsRetentionH
  /** 帧保留期(daq.frameRetentionH;env DAQ_FRAME_RETENTION_H 兼容) */
  private readonly frameRetentionH = daqRuntimeSettings().frameRetentionH
  /** 同键不同值被丢弃的帧数(C6 可观测计数,不静默) */
  private correctionDropped = 0

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    const mod = requirePg('pg') as typeof import('pg')
    // 连接池/语句超时来自 daq.timescale.*(生产调优;异常查询不得长期占用连接)
    const s = daqRuntimeSettings()
    const timeoutMs = Math.max(1000, Math.min(300_000, Number(s.timescale.statementTimeoutMs)))
    // pg 运行期支持 statement_timeout(连接参数),但 @types/pg 未声明 → 收窄后传入
    const poolConfig = {
      connectionString: this.url,
      max: Math.max(1, Math.min(32, Number(s.timescale.poolMax))),
      statement_timeout: timeoutMs,
    } as unknown as import('pg').PoolConfig
    this.pool = new mod.Pool(poolConfig)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS daq_samples (
        node_id text        NOT NULL,
        ts       timestamptz NOT NULL,
        value    double precision NOT NULL,
        state    text        NOT NULL DEFAULT 'ok',
        PRIMARY KEY (node_id, ts)
      );
    `)
    // hypertable 幂等创建(未装 timescaledb 扩展时报错 → 由工厂降级)
    await this.pool.query(
      `SELECT create_hypertable('daq_samples', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`,
    )
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_daq_samples_node_ts ON daq_samples (node_id, ts DESC)`)
    // 存量库迁移:先补打标列(幂等;已存在时报错吞掉),再建依赖列的索引
    for (const ddl of [
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS line_id text',
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS product_id text',
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS recipe_id text',
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS run_id text',
      // 到达时间(首次入库;旧行为 NULL = unknown)
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS ingested_at bigint',
    ]) {
      await this.pool.query(ddl).catch(() => {})
    }
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_daq_samples_tag ON daq_samples (product_id, recipe_id, ts DESC)`).catch(() => {})
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_daq_samples_page ON daq_samples (node_id, ts ASC)`).catch(() => {})
    // 帧表(v2:向量/图像元数据;像素 blob 在对象存储,JSONB 承载点列与派生指标;
    // DDL 为静态字面量,零外部输入)
    await this.pool.query('CREATE TABLE IF NOT EXISTS daq_frames (node_id text NOT NULL, ts timestamptz NOT NULL, kind text NOT NULL, template_key text, device_binding_id text, line_id text, product_id text, recipe_id text, run_id text, points integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT \'{}\'::jsonb, metrics jsonb NOT NULL DEFAULT \'{}\'::jsonb, PRIMARY KEY (node_id, ts))').catch(() => {})
    await this.pool.query(`SELECT create_hypertable('daq_frames', 'ts', if_not_exists => TRUE, migrate_data => TRUE)`).catch(() => {})
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_daq_frames_node_ts ON daq_frames (node_id, ts DESC)`).catch(() => {})
    // P0-3 物理参数(chunk=1 天 + 列存压缩;逐条守护)
    await this.applyPhysicalPolicies()
    // 保留期:drop_chunks 周期执行(30min;未装扩展时静默跳过)
    void this.sweepRetention()
    if (!this.retentionTimer) {
      this.retentionTimer = setInterval(() => void this.sweepRetention(), 30 * 60_000)
      this.retentionTimer.unref?.()
    }
  }

  /**
   * P0-3 物理(chunk/压缩)策略 —— 逐条守护,任一失败只告警不阻断 init:
   * init 整体失败会被工厂降级 SQLite(等于扔掉生产库),绝不允许。
   *  - chunk 钉 1 天(扩展默认 7 天 → drop_chunks 粒度过粗,空间回收滞后保留期一个 chunk);
   *    与对象存储 GC 的 UTC 天前缀、保留期注释同一粒度。set_chunk_time_interval 只影响未来 chunk,
   *    存量 7 天 chunk 靠 retention 自然出清。
   *  - 列存压缩 segmentby=node_id / orderby=ts DESC(PK 全覆盖,ON CONFLICT 语义保持);
   *    压缩窗 1 天 —— 活动 chunk 永不解压,写入冲突恒落未压缩 chunk;迟到 >1 天写入由
   *    TS 2.11+ 压缩 chunk DML 支持。压缩是 TSL 特性:社区镜像默认 apache license 会报错,
   *    需 docker-compose 以 `timescaledb.license=timescale` 启动(见 docker-compose.yml)。
   */
  private async applyPhysicalPolicies(): Promise<void> {
    if (!this.pool) return
    const steps: Array<[string, string]> = [
      ['chunk_interval@daq_samples', `SELECT set_chunk_time_interval('daq_samples', INTERVAL '1 day')`],
      ['chunk_interval@daq_frames', `SELECT set_chunk_time_interval('daq_frames', INTERVAL '1 day')`],
      ['compress@daq_samples', `ALTER TABLE daq_samples SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id', timescaledb.compress_orderby = 'ts DESC')`],
      ['compress@daq_frames', `ALTER TABLE daq_frames SET (timescaledb.compress, timescaledb.compress_segmentby = 'node_id', timescaledb.compress_orderby = 'ts DESC')`],
      ['compress_policy@daq_samples', `SELECT add_compression_policy('daq_samples', INTERVAL '1 day', if_not_exists => TRUE)`],
      ['compress_policy@daq_frames', `SELECT add_compression_policy('daq_frames', INTERVAL '1 day', if_not_exists => TRUE)`],
    ]
    for (const [name, sql] of steps) {
      await this.pool.query(sql).catch((err: unknown) => {
        const msg = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)
        console.warn(`[timescale] 物理策略 ${name} 未生效: ${msg} —— 列存压缩需 timescaledb.license=timescale(TSL,自托管免费)`)
      })
    }
  }

  private async sweepRetention(): Promise<void> {
    // 2026-10-30 修复:门控此前错挂在样本保留期(retentionH)上;本函数只清帧,
    // 应按帧保留期判定(0 = 永久保留帧,不清理)。
    if (!this.pool || this.frameRetentionH <= 0) return
    // 样本保留期由 TimescaleRollupStore 统一执行:它感知逐产线覆写(含"保留更久"的线),
    // 而全局 drop_chunks 会按全局保留期整块丢弃,误删长保留产线的数据。
    // 这里只保留帧元数据的全局清理(帧保留期不支持逐线覆写)。
    try {
      await this.pool.query(
        `SELECT drop_chunks('daq_frames', older_than => now() - ($1 || ' hours')::interval)`,
        [this.frameRetentionH],
      )
    }
    catch { /* 非 hypertable(扩展缺失)→ 静默 */ }
  }

  async close(): Promise<void> {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = null
    }
    await this.pool?.end().catch(() => {})
    this.pool = null
  }

  async writeSamples(rows: DaqSampleRow[]): Promise<void> {
    if (!this.pool || rows.length === 0) return
    const now = Date.now()
    // 数组化参数(unnest):纯占位符,不拼接任何值,也不拼接占位符串。
    const col = {
      node: rows.map(r => r.nodeId),
      ts: rows.map(r => new Date(r.tsMs).toISOString()),
      value: rows.map(r => r.value),
      state: rows.map(r => r.state),
      line: rows.map(r => r.lineId ?? null),
      product: rows.map(r => r.productId ?? null),
      recipe: rows.map(r => r.recipeId ?? null),
      run: rows.map(r => r.runId ?? null),
      ingested: rows.map(r => r.ingestedAt ?? now),
    }
    const inserted = await this.pool.query(
      `INSERT INTO daq_samples (node_id, ts, value, state, line_id, product_id, recipe_id, run_id, ingested_at)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::float8[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::bigint[])
       ON CONFLICT (node_id, ts) DO NOTHING
       RETURNING node_id, ts`,
      [col.node, col.ts, col.value, col.state, col.line, col.product, col.recipe, col.run, col.ingested],
    ) as { rows: Array<{ node_id: string, ts: string | Date }> }
    // 首写胜出:被忽略的键里,值/状态不同则计数(可观测,不静默更正)
    // 2026-10-30 修复:pg 对 timestamptz RETURNING 回传 Date 对象(类型标注不改变运行时),
    // 旧实现用 toISOString() 拼 key 恒不匹配 → 冲突快路径失效,每行多打一次 SELECT
    // (写入热路径 N+1)。统一用 epoch ms 做 key,两侧行同源。
    const insertedKeys = new Set(inserted.rows.map(r => `${r.node_id}\u0000${tsToMs(r.ts)}`))
    for (const r of rows) {
      if (insertedKeys.has(`${r.nodeId}\u0000${r.tsMs}`)) continue
      const prev = await this.pool.query('SELECT value, state FROM daq_samples WHERE node_id = $1 AND ts = $2', [r.nodeId, new Date(r.tsMs).toISOString()]) as { rows: Array<{ value: number, state: string }> }
      const row = prev.rows[0]
      if (row && (Math.abs(Number(row.value) - Number(r.value)) > 1e-9 || String(row.state) !== String(r.state))) this.correctionDropped++
    }
  }

  async query(nodeId: string, opts: DaqQueryOpts): Promise<TsdbPoint[]> {
    if (!this.pool) return []
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000))
    // 时间正序(ASC):与 queryTagged 契约一致 —— 消费方(daq_query 最新/最近序列、
    // daq_export 游标续页、AML 网格对齐)都按升序假设;窗口超 limit 时截取的是**最旧**段,
    // 续页游标(lastAt+1)依赖升序才能翻完整窗。
    if (opts.bucketMs && opts.bucketMs >= 100) {
      const { rows } = await this.pool.query(
        `SELECT time_bucket($1::interval, ts) AS bucket,
                avg(value)::double precision AS avg, min(value) AS min, max(value) AS max, count(*) AS cnt
         FROM daq_samples WHERE node_id = $2 AND ts >= $3 AND ts <= $4
         GROUP BY bucket ORDER BY bucket ASC LIMIT $5`,
        [`${opts.bucketMs} milliseconds`, nodeId, new Date(opts.fromMs ?? 0).toISOString(), new Date(opts.toMs ?? Date.now()).toISOString(), limit],
      )
      return rows.map(r => ({ at: Date.parse(r.bucket), avg: Number(r.avg), min: Number(r.min), max: Number(r.max), cnt: Number(r.cnt) }))
    }
    const { rows } = await this.pool.query(
      `SELECT ts, value, state FROM daq_samples WHERE node_id = $1 AND ts >= $2 AND ts <= $3
       ORDER BY ts ASC LIMIT $4`,
      [nodeId, new Date(opts.fromMs ?? 0).toISOString(), new Date(opts.toMs ?? Date.now()).toISOString(), limit],
    )
    return rows.map(r => ({ at: tsToMs(r.ts), value: Number(r.value), state: String(r.state) }))
  }

  async queryTagged(q: import('./tsdb-port').TsdbTagQuery): Promise<Map<string, import('./tsdb-port').TsdbPoint[]>> {
    const out = new Map<string, import('./tsdb-port').TsdbPoint[]>()
    if (!this.pool) return out
    const where: string[] = []
    const params: unknown[] = []
    if (q.lineId) {
      where.push(`line_id = $${params.length + 1}`)
      params.push(q.lineId)
    }
    if (q.productId) {
      where.push(`product_id = $${params.length + 1}`)
      params.push(q.productId)
    }
    if (q.recipeId) {
      where.push(`recipe_id = $${params.length + 1}`)
      params.push(q.recipeId)
    }
    if (q.runId) {
      where.push(`run_id = $${params.length + 1}`)
      params.push(q.runId)
    }
    if (q.nodeIds?.length) {
      where.push(`node_id = ANY($${params.length + 1})`)
      params.push(q.nodeIds)
    }
    where.push(`ts >= $${params.length + 1}`)
    params.push(new Date(q.fromMs ?? 0).toISOString())
    where.push(`ts <= $${params.length + 1}`)
    params.push(new Date(q.toMs ?? Date.now()).toISOString())
    const limit = Math.max(1, Math.min(q.limit ?? 2000, 1_000_000))
    const whereSql = where.join(' AND ')
    if (q.bucketMs && q.bucketMs >= 100) {
      const { rows } = await this.pool.query(
        `SELECT node_id, time_bucket($${params.length + 1}::interval, ts) AS b_at,
                avg(value)::double precision AS avg, min(value) AS min, max(value) AS max, count(*) AS cnt
         FROM daq_samples WHERE ${whereSql}
         GROUP BY node_id, b_at ORDER BY b_at ASC LIMIT $${params.length + 2}`,
        [...params, `${q.bucketMs} milliseconds`, limit],
      )
      for (const r of rows as Array<{ node_id: string, b_at: string, avg: string, min: string, max: string, cnt: string }>) {
        const list = out.get(String(r.node_id)) ?? []
        list.push({ at: tsToMs(r.b_at), avg: Number(r.avg), min: Number(r.min), max: Number(r.max), cnt: Number(r.cnt) })
        out.set(String(r.node_id), list)
      }
      return out
    }
    const { rows } = await this.pool.query(
      `SELECT node_id, ts, value, state, ingested_at FROM daq_samples WHERE ${whereSql} ORDER BY ts ASC LIMIT $${params.length + 1}`,
      [...params, limit],
    )
    for (const r of rows as Array<{ node_id: string, ts: string, value: number, state: string | null, ingested_at: string | number | null }>) {
      const list = out.get(String(r.node_id)) ?? []
      // D-P1-1(2026-10-28 审查):state/ingested_at 与 sqlite 同口径返回;
      // 否则生产后端上的坏点清洗(cleanPoints)与入库水位判定是静默空操作。
      list.push({
        at: tsToMs(r.ts),
        value: Number(r.value),
        state: String(r.state ?? 'ok'),
        ...(r.ingested_at == null ? {} : { ingestedAt: Number(r.ingested_at) }),
      })
      out.set(String(r.node_id), list)
    }
    return out
  }

  /**
   * 逐节点 raw 分页(D-P1-1,2026-10-28 审查:此前后端缺 queryTaggedPage,
   * 训练/导出在 Timescale 上退化为 query() 截断)。
   * 语义与 sqlite.adapter 完全一致:稳定 ASC、游标严格大于 afterTs、每页限额、
   * done=false 时 nextCursor = 本页最后 at。
   * 2026-10-29:支持批次标签等值过滤(line/product/recipe/run;SQL 全静态参数化,
   * 参数为 NULL 即不过滤该列;提供值即等值过滤,天然排除未打标 NULL 行)——
   * 此前训练分页不过滤标签,在 Timescale 上会把窗口内全部样本当目标批次,
   * 产品隔离退化为时间窗推断(串味隐患)。
   */
  async queryTaggedPage(nodeId: string, q: import('./tsdb-port').TsdbPageQuery = {}): Promise<import('./tsdb-port').TsdbPage> {
    if (!this.pool) return { nodeId, points: [], nextCursor: null, done: true }
    const limit = Math.max(1, Math.min(q.limit ?? 5000, 500_000))
    const from = Math.max(q.fromMs ?? 0, (q.afterTs ?? -1) + 1)
    const to = q.toMs ?? Date.now()
    const withState = q.withState !== false
    const tagOf = (v: string | undefined): string | null => (v != null && String(v).trim() !== '' ? String(v) : null)
    const args: unknown[] = [
      nodeId, new Date(from).toISOString(), new Date(to).toISOString(),
      tagOf(q.lineId), tagOf(q.productId), tagOf(q.recipeId), tagOf(q.runId), limit,
    ]
    // 静态 SQL:占位符 $4..$7 为 NULL 时该列不过滤,提供值时等值过滤(NULL 行不匹配)
    const rows = withState
      ? (await this.pool.query(
          `SELECT ts, value, state, ingested_at FROM daq_samples
           WHERE node_id = $1 AND ts >= $2 AND ts <= $3
             AND ($4::text IS NULL OR line_id = $4)
             AND ($5::text IS NULL OR product_id = $5)
             AND ($6::text IS NULL OR recipe_id = $6)
             AND ($7::text IS NULL OR run_id = $7)
           ORDER BY ts ASC LIMIT $8`,
          args,
        )).rows
      : (await this.pool.query(
          `SELECT ts, value FROM daq_samples
           WHERE node_id = $1 AND ts >= $2 AND ts <= $3
             AND ($4::text IS NULL OR line_id = $4)
             AND ($5::text IS NULL OR product_id = $5)
             AND ($6::text IS NULL OR recipe_id = $6)
             AND ($7::text IS NULL OR run_id = $7)
           ORDER BY ts ASC LIMIT $8`,
          args,
        )).rows
    const points = (rows as Array<{ ts: string, value: number, state?: string | null, ingested_at?: string | number | null }>).map(r => ({
      at: tsToMs(r.ts),
      value: Number(r.value),
      ...(withState ? { state: String(r.state ?? 'ok') } : {}),
      ...(r.ingested_at == null ? {} : { ingestedAt: Number(r.ingested_at) }),
    }))
    const done = points.length < limit
    return { nodeId, points, nextCursor: done ? null : points[points.length - 1]?.at ?? null, done }
  }

  async latest(): Promise<Map<string, DaqSampleRow>> {
    const out = new Map<string, DaqSampleRow>()
    if (!this.pool) return out
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (node_id) node_id, ts, value, state FROM daq_samples ORDER BY node_id, ts DESC`,
    )
    for (const r of rows) {
      out.set(String(r.node_id), { nodeId: String(r.node_id), tsMs: tsToMs(r.ts), value: Number(r.value), state: String(r.state) })
    }
    return out
  }

  // ===== 帧(daq_frames;元数据+JSONB,像素在对象存储)=====

  async writeFrames(rows: import('./tsdb-port').DaqFrameRow[]): Promise<void> {
    if (!this.pool || rows.length === 0) return
    // 固定占位符逐行插入 + 客户端事务(帧量级 ≤ 每节点每周期 1 条,无需动态 VALUES)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        await client.query(
          `INSERT INTO daq_frames (node_id, ts, kind, template_key, device_binding_id, line_id, product_id, recipe_id, run_id, points, meta, metrics)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
           ON CONFLICT (node_id, ts) DO NOTHING`,
          [
            r.nodeId, new Date(r.tsMs).toISOString(), r.kind, r.templateKey ?? null, r.deviceBindingId ?? null,
            r.lineId ?? null, r.productId ?? null, r.recipeId ?? null, r.runId ?? null,
            r.points, JSON.stringify(r.meta ?? {}), JSON.stringify(r.metrics ?? {}),
          ],
        )
      }
      await client.query('COMMIT')
    }
    catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
    finally {
      client.release()
    }
  }

  async queryFrames(nodeId: string, opts: import('./tsdb-port').DaqFrameQueryOpts): Promise<import('./tsdb-port').DaqFrameRecord[]> {
    if (!this.pool) return []
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000))
    const { rows } = await this.pool.query(
      `SELECT ts, kind, points, meta, metrics, device_binding_id, line_id, product_id, recipe_id, run_id
       FROM daq_frames WHERE node_id = $1 AND ($2::text IS NULL OR kind = $2) AND ts >= $3 AND ts <= $4
       ORDER BY ts DESC LIMIT $5`,
      [nodeId, opts.kind ?? null, new Date(opts.fromMs ?? 0).toISOString(), new Date(opts.toMs ?? Date.now()).toISOString(), limit],
    )
    return rows.map(r => ({
      at: tsToMs(r.ts),
      kind: String(r.kind) as 'vector' | 'image',
      points: String(r.kind) === 'vector' ? pointsFromMeta(r.meta) : undefined,
      // 与 sqlite.adapter 同法:metrics 列由本管线写入(下沉处理器产出 avg/max/brightness/zone_* 数值),
      // asObject 只做 JSON 还原(Record<string, unknown>),按端口契约收窄到 Record<string, number>(断言运行时擦除)
      metrics: asObject(r.metrics) as Record<string, number>,
      meta: asObject(r.meta),
      deviceBindingId: r.device_binding_id ?? null,
      lineId: r.line_id ?? null,
      productId: r.product_id ?? null,
      recipeId: r.recipe_id ?? null,
      runId: r.run_id ?? null,
    }))
  }
}

/** 向量点列从 meta.points 还原(非数组/越界防御) */
function pointsFromMeta(meta: unknown): number[] | undefined {
  const p = asObject(meta).points
  if (!Array.isArray(p) || p.length === 0 || p.length > 4096) return undefined
  return p.every(x => Number.isFinite(Number(x))) ? p.map(Number) : undefined
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    }
    catch {
      return {}
    }
  }
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
}

/** timestamptz → epoch ms(pg 返回 Date 对象;Date.parse(Date) 会经本地时区字符串丢毫秒) */
function tsToMs(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return Date.parse(String(v))
}
