/**
 * 审计实验 2:
 *  A. SQLite 保留期批量 DELETE 的耗时随表规模线性增长(全扫 → 每批一次全扫)
 *  B. InProcQueueAdapter.publish 溢出时 queue.shift() 的 O(n) 代价(10k 容量)
 * 运行:node scripts/_audit/exp-cost-scaling.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------- A ----------
function build(nodes, perNode) {
  const dir = mkdtempSync(join(tmpdir(), 'daq-audit-'))
  const db = new DatabaseSync(join(dir, 'ts.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE daq_samples (node_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, value REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok', line_id TEXT, product_id TEXT, recipe_id TEXT, run_id TEXT,
    PRIMARY KEY (node_id, ts_ms));
    CREATE INDEX idx_daq_node_ts ON daq_samples (node_id, ts_ms DESC);`)
  const ins = db.prepare('INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value) VALUES (?,?,?)')
  const now = Date.now()
  db.exec('BEGIN')
  for (let n = 0; n < nodes; n++) for (let i = 0; i < perNode; i++) ins.run(`dn-${n}`, now - i * 1000, i)
  db.exec('COMMIT')
  return { db, now }
}

const DEL = 'DELETE FROM daq_samples WHERE rowid IN (SELECT rowid FROM daq_samples WHERE ts_ms < ? LIMIT 5000)'
for (const [nodes, perNode] of [[1, 50_000], [10, 50_000], [40, 50_000]]) {
  const { db, now } = build(nodes, perNode)
  const rows = db.prepare('SELECT COUNT(*) AS c FROM daq_samples').get().c
  const cutoff = now - 3600_000 // 1h 保留
  const t0 = performance.now()
  const r = db.prepare(DEL).run(cutoff)
  const ms = performance.now() - t0
  console.log(`A: rows=${String(rows).padStart(8)}  one 5000-row batch DELETE = ${ms.toFixed(1)}ms  (deleted ${r.changes})`)
  db.close()
}

// ---------- B ----------
const QUEUE_CAP = 10_000
const q = []
let dropped = 0
const t1 = performance.now()
for (let i = 0; i < 200_000; i++) {
  if (q.length >= QUEUE_CAP) {
    q.shift()
    dropped++
  } // inproc.adapter.ts:35
  q.push({ nodeId: 'n', value: i })
}
console.log(`B: 200k publish into cap-${QUEUE_CAP} inproc queue = ${(performance.now() - t1).toFixed(1)}ms (dropped ${dropped})`)
const q2 = []
const t2 = performance.now()
for (let i = 0; i < 200_000; i++) if (q2.length < QUEUE_CAP) q2.push(i)
console.log(`B: same loop without shift (push-only baseline) = ${(performance.now() - t2).toFixed(1)}ms`)
