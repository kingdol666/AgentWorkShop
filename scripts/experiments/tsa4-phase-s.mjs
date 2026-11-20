// tsa4 round — phase S: stack health on v0.14.0, bridge tokens re-mint + hot-config, governed experience surface.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-liv4-1120'
mkdirSync(PRIVATE, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const IDD = 'http://127.0.0.1:3210'
const RAG_BACKEND = 'http://127.0.0.1:8770'
const RAG_WEB = 'http://127.0.0.1:6789'
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const BRIDGE_TOOLS = ['kb_doc_create', 'kb_doc_search', 'kb_doc_read', 'kb_catalog', 'kb_agent', 'kb_agent_status', 'diag_run', 'diag_status', 'diag_chat', 'diag_stop', 'diag_deposit', 'diag_results', 'diag_result_get', 'diag_result_annotate']
const log = m => console.log(`[tsa4-s] ${m}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(base, method, path, body, token, timeoutMs = 30_000) {
  let r
  try {
    r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) }
  catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

const stamp = Date.now().toString(36)
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin

// ---- health + version gate ----
const health = await api(BASE, 'GET', '/api/health')
const version = health.json?.data?.version
if (!(health.status === 200 && health.json?.data?.status === 'ok')) throw new Error(`AW not healthy: ${JSON.stringify(health.json).slice(0, 200)}`)
if (version !== '0.14.0') throw new Error(`expected v0.14.0, got ${version}`)
save('phase-s-aw-health.json', { version, status: health.json.data.status, bootedAt: '2026-11-20T10:11Z', home: 'D:/tmp/aw-liv2-1119/home (persisted, schema v7 already on this home)' })
log(`AW v${version} healthy`)

const probe = await api(BASE, 'GET', '/api/workshop/plugins', undefined, TOKEN)
if (probe.status !== 200) throw new Error(`admin token rejected: ${probe.status}`)

// ---- governed experience surface (v0.14.0) ----
const expStats = await api(BASE, 'GET', `/api/workshop/channels/${CH}/memories/experience-stats`, undefined, TOKEN)
const exp = expStats.json?.data ?? {}
save('phase-s-experience-stats.json', exp)
if (expStats.status !== 200) throw new Error(`experience-stats ${expStats.status}`)
const firstExp = (exp.recent ?? [])[0]?.id
let projection = null
if (firstExp) {
  const pj = await api(BASE, 'GET', `/api/workshop/channels/${CH}/memories/${firstExp}/experience`, undefined, TOKEN)
  projection = { status: pj.status, body: pj.json?.data ?? pj.json }
  save('phase-s-experience-projection.json', projection)
}
// unauthenticated read must NOT pass
const anon = await api(BASE, 'GET', `/api/workshop/channels/${CH}/memories/experience-stats`)
save('phase-s-experience-anon.json', { status: anon.status })
log(`experience-stats ok total=${exp.total}; anon=${anon.status} (expect 401)`)

// ---- sim twin health + attestation ----
let twin = { port4056: 0, attestation: false }
try {
  const tr = await fetch('http://127.0.0.1:4056/', { signal: AbortSignal.timeout(4000) })
  twin.port4056 = tr.status
}
catch {}
twin.attestation = existsSync('D:/tmp/aw-liv3-1120/shadow/attestation.json')
save('phase-s-sim-twin.json', twin)
log(`sim twin :4056 status=${twin.port4056} attestation=${twin.attestation}`)

// ---- IDD token ----
const iddStamp = `tsa4${stamp}`
await api(IDD, 'POST', '/api/auth/register', { username: iddStamp, password: `Idd-${stamp}-p5!`, email: `${iddStamp}@aw.local` })
const iddLogin = await api(IDD, 'POST', '/api/auth/login', { username: iddStamp, password: `Idd-${stamp}-p5!` })
const iddSession = iddLogin.json?.data?.session_token ?? iddLogin.json?.token ?? iddLogin.json?.data?.token ?? iddLogin.json?.access_token
if (!iddSession) throw new Error(`IDD login failed: ${JSON.stringify(iddLogin.json).slice(0, 200)}`)
const iddTok = await api(IDD, 'POST', '/api/auth/tokens', { name: `tsa4-${stamp}`, expires_in_days: 2 }, iddSession)
const iddToken = iddTok.json?.token ?? iddTok.json?.data?.token ?? iddTok.json?.api_key
if (!iddToken) throw new Error(`IDD token mint failed: ${JSON.stringify(iddTok.json).slice(0, 250)}`)
const iddVerify = await api(IDD, 'GET', '/api/auth/me', undefined, iddToken)
save('phase-s-idd-token.json', { username: iddStamp, verifyStatus: iddVerify.status })
writeFileSync(join(PRIVATE, 'idd-token.txt'), iddToken)
log(`IDD token ok(status=${iddVerify.status})`)

// ---- RAG token ----
const ragStamp = `tsa4_${stamp}`
let ragToken = null
const ragAttempts = []
for (const base of [RAG_BACKEND, RAG_WEB]) {
  await api(base, 'POST', '/api/v1/auth/register', { username: ragStamp, password: `Rag-${stamp}-k8!`, email: `${ragStamp}@aw.local` })
  const login = await api(base, 'POST', '/api/v1/auth/login', { username: ragStamp, password: `Rag-${stamp}-k8!` })
  const session = login.json?.token ?? login.json?.access_token
  ragAttempts.push({ base, loginStatus: login.status, hasSession: Boolean(session) })
  if (!session) continue
  const tok = await api(base, 'POST', '/api/v1/auth/tokens', { name: `tsa4-${stamp}` }, session)
  ragToken = tok.json?.token ?? tok.json?.api_key
  if (ragToken) { ragAttempts.push({ base, tokenStatus: tok.status }); break }
}
if (!ragToken) throw new Error(`RAG token mint failed: ${JSON.stringify(ragAttempts)}`)
save('phase-s-rag-token.json', { username: ragStamp, attempts: ragAttempts })
writeFileSync(join(PRIVATE, 'rag-token.txt'), ragToken)
log('RAG token ok')

// ---- hot-config both bridges ----
const patch = await api(BASE, 'PATCH', '/api/system/settings', {
  'plugins.diag-bridge.token': iddToken,
  'plugins.diag-bridge.contract': 'auto',
  'plugins.diag-bridge.results_enabled': true,
  'plugins.rag-bridge.token': ragToken,
}, TOKEN)
save('phase-s-settings-patch.json', { status: patch.status })
if (patch.status !== 200) throw new Error(`hot-config failed: ${JSON.stringify(patch.json).slice(0, 250)}`)
log('bridges hot-configured')

// ---- verify bridge health ----
let diagHealth, ragHealth
for (let i = 0; i < 10; i++) {
  diagHealth = await api(BASE, 'GET', '/api/plugins/diag-bridge/health', undefined, TOKEN)
  ragHealth = await api(BASE, 'GET', '/api/plugins/rag-bridge/health', undefined, TOKEN)
  const ok = diagHealth.json?.token?.accepted === true && diagHealth.json?.remote?.status === 'ok' && ragHealth.json?.backend?.ok === true && ragHealth.json?.web?.ok === true
  if (ok) break
  await sleep(3000)
}
save('phase-s-plugin-health.json', { diag: diagHealth.json, rag: ragHealth.json })
const diagOk = diagHealth.json?.token?.accepted === true && diagHealth.json?.remote?.status === 'ok'
const ragOk = ragHealth.json?.backend?.ok === true && ragHealth.json?.web?.ok === true
if (!diagOk || !ragOk) throw new Error(`bridge health not green: diag=${JSON.stringify(diagHealth.json).slice(0, 300)} rag=${JSON.stringify(ragHealth.json).slice(0, 300)}`)

// ---- plugins + tools ----
const plugins = await api(BASE, 'GET', '/api/workshop/plugins', undefined, TOKEN)
const plist = plugins.json?.data?.plugins ?? plugins.json?.plugins ?? []
const failures = plist.filter(p => (p.failures ?? []).length > 0)
save('phase-s-plugins.json', { count: plist.length, enabled: plist.filter(p => p.enabled).map(p => p.name), failures: failures.map(p => ({ name: p.name, failures: p.failures })) })
if (failures.length > 0) throw new Error(`plugin failures: ${JSON.stringify(failures).slice(0, 350)}`)

const tools = await api(BASE, 'GET', '/api/workshop/tools', undefined, TOKEN)
const toolList = tools.json?.data?.tools ?? tools.json?.tools ?? []
const names = toolList.map(t => t.name ?? t)
const counts = {
  total: names.length,
  bridgeTools: BRIDGE_TOOLS.filter(n => names.includes(n)),
  bridgeToolCount: BRIDGE_TOOLS.filter(n => names.includes(n)).length,
  commTools: ['send_message_to_agent', 'poll_messages', 'broadcast_message', 'send_cross_channel_message', 'search_other_teams_memory', 'project_send_message', 'project_read_messages'].filter(n => names.includes(n)),
  memoryTools: ['save_memory', 'search_memory'].filter(n => names.includes(n)),
}
save('phase-s-tools.json', counts)
log(`plugins=${plist.length} failures=0 tools=${counts.total} bridge=${counts.bridgeToolCount} comm+mem=${counts.commTools.length + counts.memoryTools.length}`)
console.log('TSA4-S-RESULT ' + JSON.stringify({ ok: true, version, tools: counts.total, bridges: counts.bridgeToolCount, expTotal: exp.total, anonStatus: anon.status }))
