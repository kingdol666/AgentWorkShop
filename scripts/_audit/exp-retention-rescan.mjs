/**
 * 审计实验 3:保留期 DELETE 的「每批从索引头重扫」代价。
 * 索引 = (node_id, ts_ms DESC) —— 同一节点内「新的在前、旧的在后」,
 * 因此删除最旧的行必须先走完整段未过期行。批数 = ceil(过期行/5000),
 * 每批都从索引头重新开始 → 总代价 ≈ 批数 × 每节点未过期行数。
 * 运行:node scripts/_audit/exp-retention-rescan.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function build(nodes, perNode) {
  const dir = mkdtempSync(join(tmpdir(), 'daq-audit-'))
  const db = new DatabaseSync(join(dir, 'ts.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE daq_samples (node_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, value REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok', PRIMARY KEY (node_id, ts_ms));
    CREATE INDEX idx_daq_node_ts ON daq_samples (node_id, ts_ms DESC);`)
  const ins = db.prepare('INSERT OR IGNORE INTO daq_samples (node_id, ts_ms, value) VALUES (?,?,?)')
  const now = Date.now()
  db.exec('BEGIN')
  for (let n = 0; n < nodes; n++) for (let i = 0; i < perNode; i++) ins.run(`dn-${n}`, now - i * 1000, i)
  db.exec('COMMIT')
  return { db, now }
}

const DEL = 'DELETE FROM daq_samples WHERE rowid IN (SELECT rowid FROM daq_samples WHERE ts_ms < ? LIMIT 5000)'

// 场景:每节点 200k 行(≈55h),仅最旧 ~2% 过期 → 过期行数 < 5000(单批即收敛)
for (const nodes of [1, 10, 40]) {
  const perNode = 200_000
  const { db, now } = build(nodes, perNode)
  const total = db.prepare('SELECT COUNT(*) AS c FROM daq_samples').get().c
  const cutoff = now - (perNode - 4000) * 1000 // 只让最旧 4000 行过期
  const expired = db.prepare('SELECT COUNT(*) AS c FROM daq_samples WHERE ts_ms < ?').get(cutoff).c
  const t0 = performance.now()
  const r = db.prepare(DEL).run(cutoff)
  const ms = performance.now() - t0
  console.log(`nodes=${String(nodes).padStart(3)} rows=${total} expired=${expired} → single batch DELETE ${ms.toFixed(1)}ms (deleted ${r.changes})`)
  db.close()
}
