/**
 * SqliteTimeSeriesAdapter —— TsdbPort 的开发仿真实现。
 *
 * 无 Timescale 实例时的缺省后端:同一契约落在本地 SQLite(data/daq-timeseries.sqlite),
 * 结构与时序语义对齐(ts_ms 主键 + 节点索引、bucketMs 降采样用整除分桶聚合)。
 * 生产环境配置 DAQ_TSDB_URL 即切换 Timescale,业务代码零改动。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DaqQueryOpts, DaqSampleRow, TsdbPoint, TsdbPort } from './tsdb-port'

const DB_PATH = resolve(process.cwd(), 'data', 'daq-timeseries.sqlite')

export class SqliteTimeSeriesAdapter implements TsdbPort {
  readonly backend = 'sqlite-emulated'
  private db: DatabaseSync | null = null
  /** 启动清理水位(默认保留 7 天,环境变量 DAQ_TS_RETENTION_H 可调) */
  private readonly retentionH = Number(process.env.DAQ_TS_RETENTION_H ?? 168)

  init(): void | Promise<void> {
    mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
    this.db = new DatabaseSync(DB_PATH)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daq_samples (
        node_id TEXT    NOT NULL,
        ts_ms   INTEGER NOT NULL,
        value   REAL    NOT NULL,
        state   TEXT    NOT NULL DEFAULT 'ok',
        PRIMARY KEY (node_id, ts_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_daq_node_ts ON daq_samples (node_id, ts_ms DESC);
    `)
    // 保留窗口清理(启动一次;量级受采样周期约束,足够)
    const cutoff = Date.now() - this.retentionH * 3600_000
    this.db.prepare('DELETE FROM daq_samples WHERE ts_ms < ?').run(cutoff)
  }

  async writeSamples(rows: DaqSampleRow[]): Promise<void> {
    if (!this.db || rows.length === 0) return
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value, state) VALUES (?, ?, ?, ?)',
    )
    for (const r of rows) ins.run(r.nodeId, r.tsMs, r.value, r.state)
  }

  async query(nodeId: string, opts: DaqQueryOpts): Promise<TsdbPoint[]> {
    if (!this.db) return []
    const limit = Math.min(opts.limit ?? 500, 5000)
    const from = opts.fromMs ?? 0
    const to = opts.toMs ?? Date.now()
    if (opts.bucketMs && opts.bucketMs >= 100) {
      const bucket = opts.bucketMs
      const rows = this.db.prepare(`
        SELECT (ts_ms / :b) * :b AS b_at,
               AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS cnt
        FROM daq_samples
        WHERE node_id = :id AND ts_ms >= :from AND ts_ms <= :to
        GROUP BY b_at ORDER BY b_at DESC LIMIT :lim
      `).all({ ':id': nodeId, ':from': from, ':to': to, ':b': bucket, ':lim': limit }) as Array<{ b_at: number, avg: number, min: number, max: number, cnt: number }>
      return rows.map(r => ({ at: Number(r.b_at), avg: r.avg, min: r.min, max: r.max, cnt: Number(r.cnt) }))
    }
    const rows = this.db.prepare(`
      SELECT ts_ms, value, state FROM daq_samples
      WHERE node_id = :id AND ts_ms >= :from AND ts_ms <= :to
      ORDER BY ts_ms DESC LIMIT :lim
    `).all({ ':id': nodeId, ':from': from, ':to': to, ':lim': limit }) as Array<{ ts_ms: number, value: number, state: string }>
    return rows.map(r => ({ at: Number(r.ts_ms), value: Number(r.value), state: String(r.state) }))
  }

  async latest(): Promise<Map<string, DaqSampleRow>> {
    const out = new Map<string, DaqSampleRow>()
    if (!this.db) return out
    const rows = this.db.prepare(`
      SELECT node_id, ts_ms, value, state FROM daq_samples
      WHERE ts_ms = (SELECT MAX(ts_ms) FROM daq_samples s2 WHERE s2.node_id = daq_samples.node_id)
    `).all() as Array<{ node_id: string, ts_ms: number, value: number, state: string }>
    for (const r of rows) {
      out.set(r.node_id, { nodeId: r.node_id, tsMs: Number(r.ts_ms), value: Number(r.value), state: String(r.state) })
    }
    return out
  }
}
