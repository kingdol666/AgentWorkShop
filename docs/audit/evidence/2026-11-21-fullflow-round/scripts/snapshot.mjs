#!/usr/bin/env node
/**
 * Restart-persistence snapshot: API + SQLite counters that must not change
 * (except monotonic ones) across a restart of the same AW_HOME.
 *
 * usage: node snapshot.mjs --base http://127.0.0.1:3021 \
 *          --db D:/tmp/aw-liv2-1119/home/data/workshop.sqlite --out <file>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const BASE = arg('--base', 'http://127.0.0.1:3021')
const DB = arg('--db', 'D:/tmp/aw-liv2-1119/home/data/workshop.sqlite')
const OUT = arg('--out', '')
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'

async function api(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: r.status, json }
}

const health = await api('/api/health')
const plugins = await api('/api/workshop/plugins', TOKEN)
const tools = await api('/api/workshop/tools', TOKEN)
const exp = await api(`/api/workshop/channels/${CH}/memories/experience-stats`, TOKEN)

const plist = (plugins.json?.data?.plugins ?? []).map(p => ({ name: p.name, enabled: p.enabled, toolCount: p.toolCount }))
const toolNames = (tools.json?.data?.tools ?? []).map(t => t.name ?? t).sort()

const db = new DatabaseSync(DB, { readOnly: true })
const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
const count = (t) => {
  if (!tableNames.includes(t)) return null
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0)
}
const tables = ['channels', 'channel_agents', 'channel_sessions', 'tasks', 'messages', 'agent_prefabs', 'agent_prefab_revisions', 'channel_harness_profiles', 'harness_bench_runs', 'experience_versions']
const counts = Object.fromEntries(tables.map(t => [t, count(t)]))
let benchProfiles = []
if (tableNames.includes('channel_harness_profiles')) {
  benchProfiles = db.prepare('SELECT id, status FROM channel_harness_profiles ORDER BY id').all()
}
const ledger = db.prepare('SELECT version, name FROM aw_migration_ledger ORDER BY version').all()
const expVersionRows = tableNames.includes('experience_versions') ? count('experience_versions') : null
db.close()

const snapshot = {
  at: new Date().toISOString(),
  base: BASE,
  health: { status: health.json?.data?.status, version: health.json?.data?.version },
  plugins: { count: plist.length, entries: plist, failures: plugins.json?.data?.failures ?? [] },
  tools: { total: toolNames.length, names: toolNames },
  experience: { status: exp.status, total: exp.json?.data?.total ?? null },
  db: { counts, benchProfiles, ledger, experienceVersions: expVersionRows },
}
if (OUT) writeFileSync(OUT, JSON.stringify(snapshot, null, 2))
console.log(JSON.stringify({
  health: snapshot.health,
  plugins: snapshot.plugins.count,
  tools: snapshot.tools.total,
  experience: snapshot.experience.total,
  counts,
  benchProfiles,
  ledgerMax: ledger.filter(r => r.name === 'schema-contract').map(r => r.version).pop(),
}))
