/**
 * 产线管理 + 插件集成 实机验收(US-305/US-306)——固化上轮内联检查为可复跑脚本。
 *
 * 用法: node scripts/ops-plugins-e2e.mjs <scenario-context.json>
 * 产物: docs/audit/evidence/2026-10-21-acceptance/ops-plugins.json
 *
 * US-306 产线: REST stop→start(带配方)→状态翻转 + ops-logs 审计留痕。
 * US-305 插件: Channel 插件启用面(IDD+RAG)+ Agent 工具面含 rag-bridge 注入工具
 *   (kb_agent/sentinel_*;diag_run 走 omp 引擎注入面,独立机制,不在此面)。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/ops-plugins-e2e.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-acceptance')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`)
}

async function api(method, path, body) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${c.adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: r.status, j: await r.json().catch(() => null) }
}

// ── US-306 产线 stop → start(带配方) ──
const stop = await api('POST', `/api/workshop/dcw/lines/${c.lineId}/stop`)
ok('US306.1', '产线 stop 受理', stop.status === 200, `${stop.status} ${stop.j?.message ?? ''}`)

const start = await api('POST', `/api/workshop/dcw/lines/${c.lineId}/start`, { recipeId: c.recipeId })
ok('US306.2', '产线 start 受理(带配方)', start.status === 200, `${start.status} ${start.j?.message ?? ''}`)

// 状态翻转确认(active 恢复 true)
let activeAgain = false
for (let i = 0; i < 10 && !activeAgain; i++) {
  await sleep(1500)
  const snap = (await api('GET', '/api/workshop/dcw')).j?.data
  activeAgain = Boolean(snap?.lineStates?.find(l => l.lineId === c.lineId)?.active)
}
ok('US306.2b', '产线恢复运行态(active=true)', activeAgain)

// ops-logs 留痕(line.stop + line.start)
await sleep(1000)
const logs = (await api('GET', `/api/workshop/ops-logs?scope=line&lineId=${c.lineId}&limit=100`)).j?.data?.logs ?? []
const actions = [...new Set(logs.map(l => l.action).filter(a => /^line\./.test(a)))]
ok('US306.3', 'ops-logs 含 line.start/line.stop 记录', actions.includes('line.start') && actions.includes('line.stop'), actions.join(','))

// ── US-305 插件 ──
const plugins = (await api('GET', `/api/workshop/channels/${c.channelId}/plugins`)).j?.data?.plugins ?? []
const enabled = plugins.filter(p => p.enabled).map(p => p.name)
ok('US305.1', 'Channel 插件启用 IDD+RAG', enabled.includes('idd-closedloop-bridge') && enabled.includes('rag-bridge'), enabled.join(','))

// 工具面:lead 成员(host 面与 omp 注入面同源装配)
const lead = c.agents?.lead
const list = lead?.token
  ? await fetch(`${c.base}/api/workshop/agent-tools/list?agentId=${lead.id}`, { headers: { 'x-aw-agent-token': lead.token } })
  : null
const tools = list && list.status === 200 ? ((await list.json())?.data?.tools ?? []) : []
const names = tools.map(t => t.name)
const kb = names.includes('kb_agent')
const sentinel = names.filter(n => /^sentinel_/.test(n))
ok('US305.2', 'Agent 工具面含 rag-bridge 插件工具(kb_agent/sentinel_*)——diag_run 走 omp 引擎注入面(独立机制)',
  kb && sentinel.length >= 1, `n=${names.length} kb=${kb} sentinel×${sentinel.length}`)

const pass = results.filter(r => r.pass).length
const out = { at: new Date().toISOString(), context: { base: c.base, lineId: c.lineId, channelId: c.channelId }, results, pluginEnabled: enabled, toolCount: names.length }
writeFileSync(join(EVID, 'ops-plugins.json'), JSON.stringify(out, null, 2))
console.log(`\n═══ ops+plugins: ${pass}/${results.length} PASS ═══`)
process.exit(pass === results.length ? 0 : 1)
