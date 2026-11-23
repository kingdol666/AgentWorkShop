#!/usr/bin/env node
/**
 * L1 acceptance legs that do not require external shared services:
 * health/version, plugin manifest, tool registry, experience-stats auth,
 * DB schema-contract v8 + AgentPrefab/Skill/MCP migration columns.
 * External bridges (IDD/RAG/sim twin) are recorded as NOT_RUN when unreachable.
 *
 * usage: node l1-check.mjs --base http://127.0.0.1:3021 \
 *          --db D:/tmp/aw-liv2-1119/home/data/workshop.sqlite --evidence <dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const BASE = arg('--base', 'http://127.0.0.1:3021')
const DB = arg('--db', 'D:/tmp/aw-liv2-1119/home/data/workshop.sqlite')
const EVIDENCE = arg('--evidence', 'D:/tmp/aw-e2e-1121/evidence')
const TOKEN = JSON.parse(await import('node:fs').then(m => m.readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8'))).admin
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const EXPECT_VERSION = '0.14.0'
mkdirSync(EVIDENCE, { recursive: true })

const checks = []
const notRun = []
const check = (id, ok, detail = '') => {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`${ok ? '✔' : '✖'} ${id}${detail ? ` — ${detail}` : ''}`)
}

async function api(method, path, body, token, timeoutMs = 30000) {
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (e) {
    return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } }
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text }
}

async function reachable(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: true, status: r.status }
  }
  catch (e) {
    return { ok: false, error: e.cause?.code ?? e.name }
  }
}

// 1. health + version
const health = await api('GET', '/api/health')
check('health_ok', health.status === 200 && health.json?.data?.status === 'ok', `status=${health.status}`)
check('version_matches_built_main', health.json?.data?.version === EXPECT_VERSION, `version=${health.json?.data?.version}`)

// 2. plugin manifest (persistence across builds; plugin host finishes loading after health)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let plugins = await api('GET', '/api/workshop/plugins', undefined, TOKEN)
let plist = plugins.json?.data?.plugins ?? []
for (let i = 0; i < 15 && !plist.some(p => p.name === 'mes-tool-bridge'); i++) {
  await sleep(1000)
  plugins = await api('GET', '/api/workshop/plugins', undefined, TOKEN)
  plist = plugins.json?.data?.plugins ?? []
}
const failures = plugins.json?.data?.failures ?? []
const mes = plist.find(p => p.name === 'mes-tool-bridge')
check('plugins_manifest_authorized', plugins.status === 200 && plist.length > 0, `status=${plugins.status} plugins=${plist.length}`)
check('plugins_no_load_failures', failures.length === 0, `failures=${JSON.stringify(failures).slice(0, 120)}`)
check('mes_plugin_persisted_enabled', Boolean(mes?.enabled), `scope=${mes?.scope ?? '-'} tools=${mes?.toolCount ?? '-'}`)

// 3. tool registry incl. plugin tools
const tools = await api('GET', '/api/workshop/tools', undefined, TOKEN)
const names = (tools.json?.data?.tools ?? []).map(t => t.name ?? t)
check('tool_registry_authorized', tools.status === 200 && names.length > 100, `status=${tools.status} tools=${names.length}`)
check('plugin_tools_registered', names.includes('mes_order_status') && names.includes('mes_quality_report'))
check('comm_and_memory_tools_present', ['send_message_to_agent', 'send_cross_channel_message', 'save_memory', 'search_memory'].every(n => names.includes(n)))

// 4. governed experience surface + anonymous denial
const exp = await api('GET', `/api/workshop/channels/${CH}/memories/experience-stats`, undefined, TOKEN)
const anon = await api('GET', `/api/workshop/channels/${CH}/memories/experience-stats`)
check('experience_stats_authorized', exp.status === 200, `status=${exp.status} total=${exp.json?.data?.total ?? '-'}`)
check('experience_stats_anonymous_denied', anon.status === 401 || anon.status === 403, `status=${anon.status}`)

// 5. external services: honest NOT_RUN when unreachable
for (const [id, url] of [
  ['idd_shared_service', 'http://127.0.0.1:3210/'],
  ['rag_backend_shared_service', 'http://127.0.0.1:8770/'],
  ['rag_web_shared_service', 'http://127.0.0.1:6789/'],
  ['plc_sim_twin', 'http://127.0.0.1:4056/'],
]) {
  const r = await reachable(url)
  notRun.push({ id, url, reachable: r.ok, status: r.status ?? null, error: r.error ?? null })
}
if (!notRun.find(x => x.id === 'idd_shared_service').reachable) console.log('· NOT_RUN idd_shared_service (not listening)')
if (!notRun.find(x => x.id === 'plc_sim_twin').reachable) console.log('· NOT_RUN plc_sim_twin (not listening)')

// 6. DB-level migration: contract v8 + new prefab columns/tables
const db = new DatabaseSync(DB, { readOnly: true })
try {
  const contractV8 = db.prepare("SELECT version FROM aw_migration_ledger WHERE name = 'schema-contract' AND version = 8").get()
  const contractMax = db.prepare("SELECT MAX(version) AS version FROM aw_migration_ledger WHERE name = 'schema-contract'").get()
  check('schema_contract_v8_recorded', Boolean(contractV8), `schema-contract max=${contractMax?.version}`)

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name))
  check('agent_prefab_tables_exist', tables.has('agent_prefabs') && tables.has('agent_prefab_revisions'))

  const agentCols = new Set(db.prepare('PRAGMA table_info(channel_agents)').all().map(r => r.name))
  check('channel_agents_prefab_binding_column', agentCols.has('prefab_binding_json'))

  const sessionCols = new Set(db.prepare('PRAGMA table_info(channel_sessions)').all().map(r => r.name))
  check('channel_sessions_prefab_snapshot_columns', sessionCols.has('prefab_snapshot_json') && sessionCols.has('prefab_snapshot_hash'))

  const workItemCols = new Set(db.prepare('PRAGMA table_info(project_work_items)').all().map(r => r.name))
  check('project_work_items_prefab_snapshot_columns', workItemCols.has('prefab_snapshot_json') && workItemCols.has('prefab_snapshot_hash'))

  const prefabCount = db.prepare('SELECT COUNT(*) AS n FROM agent_prefabs').get()
  console.log(`· existing agent_prefabs rows=${prefabCount?.n ?? 0}`)
}
finally {
  db.close()
}

const failed = checks.filter(c => c.status !== 'PASS').length
const summary = { total: checks.length, pass: checks.length - failed, fail: failed }
writeFileSync(join(EVIDENCE, 'l1-checks.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, checks, notRun, summary }, null, 2))
console.log(`RESULT ${JSON.stringify(summary)} notRun=${notRun.filter(x => !x.reachable).map(x => x.id).join(',') || 'none'}`)
process.exit(failed === 0 ? 0 : 1)
