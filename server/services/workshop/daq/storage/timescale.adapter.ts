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

/* nitro(Windows)dev 下对 external 的动态 import 会生成绝对盘符路径 → ESM loader
 * 拒绝 'd:' scheme;用 createRequire 走 CJS require 由 Node 原生解析(生产亦同)。 */
const requirePg = createRequire(import.meta.url)

export class TimescaleAdapter implements TsdbPort {
  readonly backend = 'timescale'
  private pool: Pool | null = null
  private retentionTimer: NodeJS.Timeout | null = null
  /** 保留期(默认 7 天,DAQ_TS_RETENTION_H 可调) */
  private readonly retentionH = Number(process.env.DAQ_TS_RETENTION_H ?? 168)

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    const mod = requirePg('pg') as typeof import('pg')
    this.pool = new mod.Pool({ connectionString: this.url, max: 4 })
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
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS product_id text',
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS recipe_id text',
      'ALTER TABLE daq_samples ADD COLUMN IF NOT EXISTS run_id text',
    ]) {
      await this.pool.query(ddl).catch(() => {})
    }
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_daq_samples_tag ON daq_samples (product_id, recipe_id, ts DESC)`).catch(() => {})
    // 保留期:drop_chunks 周期执行(30min;未装扩展时静默跳过)
    void this.sweepRetention()
    if (!this.retentionTimer) {
      this.retentionTimer = setInterval(() => void this.sweepRetention(), 30 * 60_000)
      this.retentionTimer.unref?.()
    }
  }

  private async sweepRetention(): Promise<void> {
    if (!this.pool) return
    try {
      await this.pool.query(
        `SELECT drop_chunks('daq_samples', older_than => now() - ($1 || ' hours')::interval)`,
        [this.retentionH],
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
    const values: unknown[] = []
    const tuples = rows.map((r, i) => {
      values.push(r.nodeId, new Date(r.tsMs).toISOString(), r.value, r.state, r.productId ?? null, r.recipeId ?? null, r.runId ?? null)
      const b = i * 7
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`
    })
    await this.pool.query(
      `INSERT INTO daq_samples (node_id, ts, value, state, product_id, recipe_id, run_id) VALUES ${tuples.join(',')}
       ON CONFLICT (node_id, ts) DO NOTHING`,
      values,
    )
  }

  async query(nodeId: string, opts: DaqQueryOpts): Promise<TsdbPoint[]> {
    if (!this.pool) return []
    const limit = Math.min(opts.limit ?? 500, 5000)
    if (opts.bucketMs && opts.bucketMs >= 100) {
      const { rows } = await this.pool.query(
        `SELECT time_bucket($1::interval, ts) AS bucket,
                avg(value)::double precision AS avg, min(value) AS min, max(value) AS max, count(*) AS cnt
         FROM daq_samples WHERE node_id = $2 AND ts >= $3 AND ts <= $4
         GROUP BY bucket ORDER BY bucket DESC LIMIT $5`,
        [`${opts.bucketMs} milliseconds`, nodeId, new Date(opts.fromMs ?? 0).toISOString(), new Date(opts.toMs ?? Date.now()).toISOString(), limit],
      )
      return rows.map(r => ({ at: Date.parse(r.bucket), avg: Number(r.avg), min: Number(r.min), max: Number(r.max), cnt: Number(r.cnt) }))
    }
    const { rows } = await this.pool.query(
      `SELECT ts, value, state FROM daq_samples WHERE node_id = $1 AND ts >= $2 AND ts <= $3
       ORDER BY ts DESC LIMIT $4`,
      [nodeId, new Date(opts.fromMs ?? 0).toISOString(), new Date(opts.toMs ?? Date.now()).toISOString(), limit],
    )
    return rows.map(r => ({ at: Date.parse(r.ts), value: Number(r.value), state: String(r.state) }))
  }

  async queryTagged(q: import('./tsdb-port').TsdbTagQuery): Promise<Map<string, import('./tsdb-port').TsdbPoint[]>> {
    const out = new Map<string, import('./tsdb-port').TsdbPoint[]>()
    if (!this.pool) return out
    const where: string[] = []
    const params: unknown[] = []
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
    const limit = Math.min(q.limit ?? 2000, 10_000)
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
        list.push({ at: Date.parse(r.b_at), avg: Number(r.avg), min: Number(r.min), max: Number(r.max), cnt: Number(r.cnt) })
        out.set(String(r.node_id), list)
      }
      return out
    }
    const { rows } = await this.pool.query(
      `SELECT node_id, ts, value FROM daq_samples WHERE ${whereSql} ORDER BY ts ASC LIMIT $${params.length + 1}`,
      [...params, limit],
    )
    for (const r of rows as Array<{ node_id: string, ts: string, value: number }>) {
      const list = out.get(String(r.node_id)) ?? []
      list.push({ at: Date.parse(r.ts), value: Number(r.value) })
      out.set(String(r.node_id), list)
    }
    return out
  }

  async latest(): Promise<Map<string, DaqSampleRow>> {
    const out = new Map<string, DaqSampleRow>()
    if (!this.pool) return out
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (node_id) node_id, ts, value, state FROM daq_samples ORDER BY node_id, ts DESC`,
    )
    for (const r of rows) {
      out.set(String(r.node_id), { nodeId: String(r.node_id), tsMs: Date.parse(r.ts), value: Number(r.value), state: String(r.state) })
    }
    return out
  }
}
