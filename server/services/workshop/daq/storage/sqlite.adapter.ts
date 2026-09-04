/**
 * SqliteTimeSeriesAdapter —— TsdbPort 的开发仿真实现。
 *
 * 无 Timescale 实例时的缺省后端:同一契约落在本地 SQLite(data/daq-timeseries.sqlite),
 * 结构与时序语义对齐(ts_ms 主键 + 节点索引、bucketMs 降采样用整除分桶聚合)。
 * 生产环境配置 DAQ_TSDB_URL 即切换 Timescale,业务代码零改动。
 */
import { createLogger } from '../../logger'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureDataDir } from '@/shared/config/home.mjs'
import type { DaqQueryOpts, DaqSampleRow, TsdbPoint, TsdbPort } from './tsdb-port'
import { daqRuntimeSettings } from '../../settings'

const log = createLogger('daq.tsdb.sqlite')

const DB_PATH = join(ensureDataDir(), 'daq-timeseries.sqlite')

export class SqliteTimeSeriesAdapter implements TsdbPort {
  readonly backend = 'sqlite-emulated'
  private db: DatabaseSync | null = null
  /** 启动清理水位(daq.tsRetentionH;env DAQ_TS_RETENTION_H 兼容) */
  private readonly retentionH = daqRuntimeSettings().tsRetentionH
  private retentionTimer: NodeJS.Timeout | null = null

  async init(): Promise<void> {
    this.db = new DatabaseSync(DB_PATH)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // WAL + NORMAL:批写单事务一次 fsync,兼顾持久性与事件循环停顿
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daq_samples (
        node_id TEXT    NOT NULL,
        ts_ms   INTEGER NOT NULL,
        value   REAL    NOT NULL,
        state   TEXT    NOT NULL DEFAULT 'ok',
        line_id    TEXT,
        product_id TEXT,
        recipe_id  TEXT,
        run_id     TEXT,
        PRIMARY KEY (node_id, ts_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_daq_node_ts ON daq_samples (node_id, ts_ms DESC);
    `)
    // 存量库迁移:先补打标列(幂等),再建依赖列的索引
    const cols = new Set((this.db.prepare('PRAGMA table_info(daq_samples)').all() as Array<{ name: string }>).map(c => c.name))
    for (const [col, ddl] of [['line_id', 'ALTER TABLE daq_samples ADD COLUMN line_id TEXT'], ['product_id', 'ALTER TABLE daq_samples ADD COLUMN product_id TEXT'], ['recipe_id', 'ALTER TABLE daq_samples ADD COLUMN recipe_id TEXT'], ['run_id', 'ALTER TABLE daq_samples ADD COLUMN run_id TEXT']] as const) {
      if (!cols.has(col)) this.db.exec(ddl)
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_daq_tag ON daq_samples (product_id, recipe_id, ts_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_daq_run ON daq_samples (run_id, ts_ms DESC);
    `)
    // 帧表(v2:向量/图像;meta/metrics JSON 序列化 TEXT,与 Timescale 契约对齐)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daq_frames (
        node_id TEXT    NOT NULL,
        ts_ms   INTEGER NOT NULL,
        kind    TEXT    NOT NULL,
        template_key TEXT,
        device_binding_id TEXT,
        line_id TEXT, product_id TEXT, recipe_id TEXT, run_id TEXT,
        points  INTEGER NOT NULL DEFAULT 0,
        meta    TEXT    NOT NULL DEFAULT '{}',
        metrics TEXT    NOT NULL DEFAULT '{}',
        PRIMARY KEY (node_id, ts_ms)
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_daq_frames_node_ts ON daq_frames (node_id, ts_ms DESC)')
    // 保留窗口:启动清一次 + 后台周期任务(30min,防长会话磁盘无限涨)
    this.sweepRetention()
    this.sweepFrameRetention()
    if (!this.retentionTimer) {
      this.retentionTimer = setInterval(() => {
        this.sweepRetention()
        this.sweepFrameRetention()
      }, 30 * 60_000)
      this.retentionTimer.unref?.()
    }
  }

  /** 保留期清理:分批 DELETE(单批 5000 行,避免长事务锁库) */
  private sweepRetention(): void {
    if (!this.db) return
    const cutoff = Date.now() - this.retentionH * 3600_000
    try {
      let removed = 0
      for (;;) {
        const r = this.db.prepare(
          'DELETE FROM daq_samples WHERE rowid IN (SELECT rowid FROM daq_samples WHERE ts_ms < ? LIMIT 5000)',
        ).run(cutoff)
        removed += Number(r.changes)
        if (Number(r.changes) < 5000) break
      }
      if (removed > 0) log.info(`[daq-tsdb] 保留期清理 ${removed} 行(>${this.retentionH}h)`)
    }
    catch (err) {
      log.error('[daq-tsdb] 保留期清理失败:', err instanceof Error ? err.message : err)
    }
  }

  async writeSamples(rows: DaqSampleRow[]): Promise<void> {
    if (!this.db || rows.length === 0) return
    // 批内单事务:一次 fsync 落整批(逐行 run 会每行一次 WAL fsync,写放大)
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value, state, line_id, product_id, recipe_id, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN')
    try {
      for (const r of rows) ins.run(r.nodeId, r.tsMs, r.value, r.state, r.lineId ?? null, r.productId ?? null, r.recipeId ?? null, r.runId ?? null)
      this.db.exec('COMMIT')
    }
    catch (err) {
      try {
        this.db.exec('ROLLBACK')
      }
      catch { /* 事务已终结 */ }
      throw err
    }
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

  async queryTagged(q: import('./tsdb-port').TsdbTagQuery): Promise<Map<string, import('./tsdb-port').TsdbPoint[]>> {
    const out = new Map<string, import('./tsdb-port').TsdbPoint[]>()
    if (!this.db) return out
    const where: string[] = []
    const params: Array<string | number> = []
    if (q.lineId) {
      where.push('line_id = ?')
      params.push(q.lineId)
    }
    if (q.productId) {
      where.push('product_id = ?')
      params.push(q.productId)
    }
    if (q.recipeId) {
      where.push('recipe_id = ?')
      params.push(q.recipeId)
    }
    if (q.runId) {
      where.push('run_id = ?')
      params.push(q.runId)
    }
    if (q.nodeIds?.length) {
      where.push(`node_id IN (${q.nodeIds.map(() => '?').join(',')})`)
      params.push(...q.nodeIds)
    }
    where.push('ts_ms >= ?')
    params.push(q.fromMs ?? 0)
    where.push('ts_ms <= ?')
    params.push(q.toMs ?? Date.now())
    const limit = Math.min(q.limit ?? 2000, 10_000)
    if (q.bucketMs && q.bucketMs >= 100) {
      const rows2 = (this.db.prepare(`
        SELECT node_id, (ts_ms / ?) * ? AS b_at, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS cnt
        FROM daq_samples WHERE ${where.join(' AND ')}
        GROUP BY node_id, b_at ORDER BY b_at ASC LIMIT ?
      `).all(q.bucketMs, q.bucketMs, ...params, limit)) as Array<{ node_id: string, b_at: number, avg: number, min: number, max: number, cnt: number }>
      for (const r of rows2) {
        const list = out.get(r.node_id) ?? []
        list.push({ at: Number(r.b_at), avg: r.avg, min: r.min, max: r.max, cnt: Number(r.cnt) })
        out.set(r.node_id, list)
      }
      return out
    }
    const rows = (this.db.prepare(`
      SELECT node_id, ts_ms, value FROM daq_samples WHERE ${where.join(' AND ')}
      ORDER BY ts_ms ASC LIMIT ?
    `).all(...params, limit)) as Array<{ node_id: string, ts_ms: number, value: number }>
    for (const r of rows) {
      const list = out.get(r.node_id) ?? []
      list.push({ at: Number(r.ts_ms), value: r.value })
      out.set(r.node_id, list)
    }
    return out
  }

  async latest(): Promise<Map<string, DaqSampleRow>> {
    const out = new Map<string, DaqSampleRow>()
    if (!this.db) return out
    // SQLite 裸列保证:GROUP BY + MAX() 时裸列取自 max 所在行(命中 idx_daq_node_ts,免相关子查询)
    const rows = this.db.prepare(`
      SELECT node_id, MAX(ts_ms) AS ts_ms, value, state FROM daq_samples GROUP BY node_id
    `).all() as Array<{ node_id: string, ts_ms: number, value: number, state: string }>
    for (const r of rows) {
      out.set(r.node_id, { nodeId: r.node_id, tsMs: Number(r.ts_ms), value: Number(r.value), state: String(r.state) })
    }
    return out
  }

  // ===== 帧(daq_frames;与 Timescale 同契约)=====

  async writeFrames(rows: import('./tsdb-port').DaqFrameRow[]): Promise<void> {
    if (!this.db || rows.length === 0) return
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO daq_frames (node_id, ts_ms, kind, template_key, device_binding_id, line_id, product_id, recipe_id, run_id, points, meta, metrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        ins.run(r.nodeId, r.tsMs, r.kind, r.templateKey ?? null, r.deviceBindingId ?? null, r.lineId ?? null, r.productId ?? null, r.recipeId ?? null, r.runId ?? null, r.points, JSON.stringify(r.meta ?? {}), JSON.stringify(r.metrics ?? {}))
      }
      this.db.exec('COMMIT')
    }
    catch (err) {
      try {
        this.db.exec('ROLLBACK')
      }
      catch { /* 事务已终结 */ }
      throw err
    }
  }

  async queryFrames(nodeId: string, opts: import('./tsdb-port').DaqFrameQueryOpts): Promise<import('./tsdb-port').DaqFrameRecord[]> {
    if (!this.db) return []
    const limit = Math.min(opts.limit ?? 100, 1000)
    const rows = this.db.prepare(`
      SELECT ts_ms, kind, meta, metrics, device_binding_id, line_id, product_id, recipe_id, run_id
      FROM daq_frames
      WHERE node_id = :id AND (:kind IS NULL OR kind = :kind) AND ts_ms >= :from AND ts_ms <= :to
      ORDER BY ts_ms DESC LIMIT :lim
    `).all({
      ':id': nodeId,
      ':kind': opts.kind ?? null,
      ':from': opts.fromMs ?? 0,
      ':to': opts.toMs ?? Date.now(),
      ':lim': limit,
    }) as Array<{ ts_ms: number, kind: string, meta: string, metrics: string, device_binding_id: string | null, line_id: string | null, product_id: string | null, recipe_id: string | null, run_id: string | null }>
    return rows.map(r => ({
      at: Number(r.ts_ms),
      kind: String(r.kind) as 'vector' | 'image',
      points: r.kind === 'vector' ? pointsFromMeta(asObject(r.meta)) : undefined,
      metrics: asObject(r.metrics) as Record<string, number>,
      meta: asObject(r.meta),
      deviceBindingId: r.device_binding_id,
      lineId: r.line_id,
      productId: r.product_id,
      recipeId: r.recipe_id,
      runId: r.run_id,
    }))
  }

  /** 帧保留期清理(与样本同拍;daq.frameRetentionH,env DAQ_FRAME_RETENTION_H 兼容) */
  private sweepFrameRetention(): void {
    if (!this.db) return
    const cutoff = Date.now() - daqRuntimeSettings().frameRetentionH * 3600_000
    try {
      this.db.prepare('DELETE FROM daq_frames WHERE ts_ms < ?').run(cutoff)
    }
    catch (err) {
      log.error('[daq-tsdb] 帧保留期清理失败:', err instanceof Error ? err.message : err)
    }
  }

  close(): Promise<void> | void {
    this.sweepRetentionTimerStop()
    this.db?.close()
    this.db = null
  }

  private sweepRetentionTimerStop(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = null
    }
  }
}

/** 向量点列从 meta JSON 还原(非数组/越界防御) */
function pointsFromMeta(meta: Record<string, unknown>): number[] | undefined {
  const p = meta.points
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
