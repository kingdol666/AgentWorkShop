// tsa4 round — write-attempt ledger snapshot (read-only) for restart-reconciliation evidence.
// Usage: node scripts/experiments/tsa4-reconcile.mjs before|after
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const phase = process.argv[2] ?? 'before'
const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
const DB = 'D:/tmp/aw-liv2-1119/home/data/workshop.sqlite'

const db = new DatabaseSync(DB, { readOnly: true })
const out = { phase, at: new Date().toISOString(), tables: {} }
try {
  const rows = db.prepare('SELECT * FROM dcw_write_attempts ORDER BY rowid').all()
  out.tables.writeAttempts = rows.map(r => ({
    id: String(r.id ?? '').slice(0, 18),
    node: String(r.nodeId ?? r.node_id ?? '').slice(0, 18),
    outcome: r.outcome ?? r.state ?? r.status,
    dispatchedAt: r.dispatchedAt ?? r.dispatched_at ?? null,
    settledAt: r.settledAt ?? r.settled_at ?? r.updated_at ?? null,
    reconcileAction: r.reconcileAction ?? r.reconcile_action ?? null,
  }))
  const counts = {}
  for (const r of out.tables.writeAttempts) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
  out.countsByOutcome = counts
}
catch (e) {
  out.tables.writeAttemptsError = String(e.message).slice(0, 200)
}
// experience governance rows (migration evidence)
try {
  const vers = db.prepare('SELECT state, deployment, COUNT(*) n FROM experience_versions GROUP BY state, deployment').all()
  out.tables.experienceVersions = vers
}
catch (e) {
  out.tables.experienceVersionsError = String(e.message).slice(0, 200)
}
try {
  const legacy = db.prepare('SELECT COUNT(*) n FROM experience_versions WHERE state = \'legacy-unverified\'').get()
  out.tables.legacyUnverified = legacy?.n ?? 0
}
catch {}
db.close()
writeFileSync(join(EV, `reconcile-${phase}.json`), JSON.stringify(out, null, 1))
console.log(`RECONCILE-${phase} ` + JSON.stringify({ attempts: out.tables.writeAttempts?.length ?? null, counts: out.countsByOutcome ?? null, legacyUnverified: out.tables.legacyUnverified ?? null }))
