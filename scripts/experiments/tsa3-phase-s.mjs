// tsa3 round — phase S: reuse the persisted home/admin, re-mint bridge tokens, hot-configure and verify.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-governed-acceptance-round')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-liv3-1120'
mkdirSync(PRIVATE, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const IDD = 'http://127.0.0.1:3210'
const RAG_BACKEND = 'http://127.0.0.1:8770'
const RAG_WEB = 'http://127.0.0.1:6789'
const BRIDGE_TOOLS = ['kb_doc_create', 'kb_doc_search', 'kb_doc_read', 'kb_catalog', 'kb_agent', 'kb_agent_status', 'diag_run', 'diag_status', 'diag_chat', 'diag_stop', 'diag_deposit', 'diag_results', 'diag_result_get', 'diag_result_annotate']
const log = m => console.log(`[tsa3-s] ${m}`)
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

const health = await api(BASE, 'GET', '/api/health')
if (!(health.status === 200 && health.json?.data?.status === 'ok')) throw new Error(`AW not healthy: ${JSON.stringify(health.json).slice(0, 200)}`)
save('phase-s-aw-health.json', { health: health.json.data, startedAt: '2026-11-20T03:05Z', home: 'D:/tmp/aw-liv2-1119/home (persisted, revived)' })

const oldTokens = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8'))
const admin = { token: oldTokens.admin }
const probe = await api(BASE, 'GET', '/api/workshop/plugins', undefined, admin.token)
if (probe.status !== 200) throw new Error(`persisted admin token rejected: ${probe.status}`)
log('admin token 从持久 home 复用有效')

// ---- IDD token ----
const iddStamp = `tsa3${stamp}`
await api(IDD, 'POST', '/api/auth/register', { username: iddStamp, password: `Idd-${stamp}-p5!`, email: `${iddStamp}@aw.local` })
const iddLogin = await api(IDD, 'POST', '/api/auth/login', { username: iddStamp, password: `Idd-${stamp}-p5!` })
const iddSession = iddLogin.json?.data?.session_token ?? iddLogin.json?.token ?? iddLogin.json?.data?.token ?? iddLogin.json?.access_token
if (!iddSession) throw new Error(`IDD login failed: ${JSON.stringify(iddLogin.json).slice(0, 200)}`)
const iddTok = await api(IDD, 'POST', '/api/auth/tokens', { name: `tsa3-${stamp}`, expires_in_days: 2 }, iddSession)
const iddToken = iddTok.json?.token ?? iddTok.json?.data?.token ?? iddTok.json?.api_key
if (!iddToken) throw new Error(`IDD token mint failed: ${JSON.stringify(iddTok.json).slice(0, 250)}`)
const iddVerify = await api(IDD, 'GET', '/api/auth/me', undefined, iddToken)
save('phase-s-idd-token.json', { username: iddStamp, verifyStatus: iddVerify.status })
writeFileSync(join(PRIVATE, 'idd-token.txt'), iddToken)
log(`IDD token ok(status=${iddVerify.status})`)

// ---- RAG token ----
const ragStamp = `tsa3_${stamp}`
let ragToken = null
const ragAttempts = []
for (const base of [RAG_BACKEND, RAG_WEB]) {
  await api(base, 'POST', '/api/v1/auth/register', { username: ragStamp, password: `Rag-${stamp}-k8!`, email: `${ragStamp}@aw.local` })
  const login = await api(base, 'POST', '/api/v1/auth/login', { username: ragStamp, password: `Rag-${stamp}-k8!` })
  const session = login.json?.token ?? login.json?.access_token
  ragAttempts.push({ base, loginStatus: login.status, hasSession: Boolean(session) })
  if (!session) continue
  const tok = await api(base, 'POST', '/api/v1/auth/tokens', { name: `tsa3-${stamp}` }, session)
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
}, admin.token)
save('phase-s-settings-patch.json', { status: patch.status })
if (patch.status !== 200) throw new Error(`hot-config failed: ${JSON.stringify(patch.json).slice(0, 250)}`)
log('bridges hot-configured')

// ---- verify ----
let diagHealth, ragHealth
for (let i = 0; i < 10; i++) {
  diagHealth = await api(BASE, 'GET', '/api/plugins/diag-bridge/health', undefined, admin.token)
  ragHealth = await api(BASE, 'GET', '/api/plugins/rag-bridge/health', undefined, admin.token)
  const ok = diagHealth.json?.token?.accepted === true && diagHealth.json?.remote?.status === 'ok' && ragHealth.json?.backend?.ok === true && ragHealth.json?.web?.ok === true
  if (ok) break
  await sleep(3000)
}
save('phase-s-plugin-health.json', { diag: diagHealth.json, rag: ragHealth.json })
const diagOk = diagHealth.json?.token?.accepted === true && diagHealth.json?.remote?.status === 'ok'
const ragOk = ragHealth.json?.backend?.ok === true && ragHealth.json?.web?.ok === true
if (!diagOk || !ragOk) throw new Error(`bridge health not green: diag=${JSON.stringify(diagHealth.json).slice(0, 300)} rag=${JSON.stringify(ragHealth.json).slice(0, 300)}`)

const plugins = await api(BASE, 'GET', '/api/workshop/plugins', undefined, admin.token)
const plist = plugins.json?.data?.plugins ?? plugins.json?.plugins ?? []
const failures = plist.filter(p => (p.failures ?? []).length > 0)
save('phase-s-plugins.json', { count: plist.length, enabled: plist.filter(p => p.enabled).map(p => p.name), failures: failures.map(p => ({ name: p.name, failures: p.failures })) })
if (failures.length > 0) throw new Error(`plugin failures: ${JSON.stringify(failures).slice(0, 350)}`)

const tools = await api(BASE, 'GET', '/api/workshop/tools', undefined, admin.token)
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
console.log('TSA3-S-RESULT ' + JSON.stringify({ ok: true, tools: counts.total, bridges: counts.bridgeToolCount }))
