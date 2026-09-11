/**
 * 审计实验:复刻 SqliteTimeSeriesAdapter 的建表 + 保留期清理 SQL,
 * 用 EXPLAIN QUERY PLAN + 计时证明「保留期 DELETE 走全表扫描」。
 * 运行:node scripts/_audit/exp-retention-plan.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'daq-audit-'))
const db = new DatabaseSync(join(dir, 'ts.sqlite'))
db.exec('PRAGMA journal_mode = WAL')

// —— 与 sqlite.adapter.ts:35-73 同构的 DDL ——
db.exec(`
  CREATE TABLE IF NOT EXISTS daq_samples (
    node_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, value REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok', line_id TEXT, product_id TEXT, recipe_id TEXT, run_id TEXT,
    PRIMARY KEY (node_id, ts_ms)
  );
  CREATE INDEX IF NOT EXISTS idx_daq_node_ts ON daq_samples (node_id, ts_ms DESC);
  CREATE TABLE IF NOT EXISTS daq_frames (
    node_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, template_key TEXT,
    device_binding_id TEXT, line_id TEXT, product_id TEXT, recipe_id TEXT, run_id TEXT,
    points INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}', metrics TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (node_id, ts_ms)
  );
  CREATE INDEX IF NOT EXISTS idx_daq_frames_node_ts ON daq_frames (node_id, ts_ms DESC);
`)

const NODES = 50
const PER_NODE = 4000 // 200k rows total
const now = Date.now()
const ins = db.prepare('INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value, state) VALUES (?,?,?,?)')
db.exec('BEGIN')
for (let n = 0; n < NODES; n++) {
  for (let i = 0; i < PER_NODE; i++) ins.run(`dn-${n}`, now - i * 1000, n + i / 1000, 'ok')
}
db.exec('COMMIT')
const total = db.prepare('SELECT COUNT(*) AS c FROM daq_samples').get().c
console.log(`rows=${total}`)

const cutoff = now - 168 * 3600_000 // tsRetentionH 缺省 168h
const sql = 'DELETE FROM daq_samples WHERE rowid IN (SELECT rowid FROM daq_samples WHERE ts_ms < ? LIMIT 5000)'
console.log('\n--- EXPLAIN QUERY PLAN (retention DELETE, sqlite.adapter.ts:94) ---')
for (const r of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(cutoff)) console.log(r.detail)

console.log('\n--- EXPLAIN QUERY PLAN (frame retention DELETE, sqlite.adapter.ts:280) ---')
for (const r of db.prepare('EXPLAIN QUERY PLAN DELETE FROM daq_frames WHERE ts_ms < ?').all(cutoff)) console.log(r.detail)

console.log('\n--- timing ---')
const t0 = Date.now()
let removed = 0
for (;;) {
  const r = db.prepare(sql).run(cutoff)
  removed += Number(r.changes)
  if (Number(r.changes) < 5000) break
}
console.log(`sweep deleted ${removed} rows in ${Date.now() - t0}ms`)
db.close()
