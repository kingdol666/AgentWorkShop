/**
 * scripts/experiments/tsa-phase-s.mjs —— 三端验收 阶段S:AW 隔离实例 + 插件热配(2026-11-19)。
 *
 * 前置:IDD :3210 与 RAG :8770/:6789 已在线(本轮不重复启动、不停止)。
 * 职责:
 *   1) detached 启动全新 AW_HOME 实例(:3021, 0.13.0),健康门 status=ok && workshop=ready
 *   2) 注册 admin + 第二账号(L1/L2 与越权负例用)
 *   3) 铸 IDD(idd_)/RAG(sk-)token → PATCH /api/system/settings 热配两桥
 *   4) 验证:插件 health、插件清单 failures=[]、工具注册面计数
 * 证据:docs/audit/evidence/2026-11-19-three-system-acceptance/phase-s-*.json
 * token 明文只落 D:/tmp/aw-tsa-1119/(私有),不入证据目录。
 * 断点续跑:私有记录(实例 pid + 账号 token)齐全且 :3021 健康时,跳过启动/账号段,直接从铸 token 段继续。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.NO_PROXY_LIST = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-three-system-acceptance')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-tsa-1119'
mkdirSync(PRIVATE, { recursive: true })

const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const AW_PORT = 3021
const BASE = `http://127.0.0.1:${AW_PORT}`
const IDD = 'http://127.0.0.1:3210'
const RAG_WEB = 'http://127.0.0.1:6789'
const RAG_BACKEND = 'http://127.0.0.1:8770'
const HOME = 'D:/tmp/aw-tsa-1119/home'
const LOG = 'D:/tmp/aw-tsa-1119/aw-detached.log'
const SESSION_PASSWORD = `Tsa-${Date.now()}-session-key-0192`
const BRIDGE_TOOLS = ['kb_doc_create', 'kb_doc_search', 'kb_doc_read', 'kb_catalog', 'kb_agent', 'kb_agent_status', 'diag_run', 'diag_status', 'diag_chat', 'diag_stop', 'diag_deposit', 'diag_results', 'diag_result_get', 'diag_result_annotate']

const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))
const readPrivate = (name) => JSON.parse(readFileSync(join(PRIVATE, name), 'utf8'))
const log = (m) => console.log(`[phase-s] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(base, method, path, body, token, timeoutMs = 30_000) {
  let r
  try {
    r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (e) {
    return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } }
  }
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 500) } }
  return { status: r.status, json }
}

// ---- 断点续跑入口:实例健康 + 私有记录齐全 → 直接从铸 token 段继续 ----
async function resumeIfNeeded(health) {
  const hasAll = existsSync(join(PRIVATE, 'aw-instance.json')) && existsSync(join(PRIVATE, 'aw-tokens.json'))
  if (!(health.status === 200 && health.json?.data?.status === 'ok' && hasAll)) return false
  const state = { instance: readPrivate('aw-instance.json'), tokens: readPrivate('aw-tokens.json') }
  log(`复用本轮实例 pid=${state.instance.pid}(version=${health.json?.data?.version}),跳过启动/账号段`)
  await mintAndConfigure({ token: state.tokens.admin })
  return true
}

async function mintAndConfigure(admin) {
  const stamp = Date.now().toString(36)
  // ---- 铸 IDD token ----
  const iddStamp = `tsa${stamp}`
  await api(IDD, 'POST', '/api/auth/register', { username: iddStamp, password: `Idd-${stamp}-p5!`, email: `${iddStamp}@aw.local` })
  const iddLogin = await api(IDD, 'POST', '/api/auth/login', { username: iddStamp, password: `Idd-${stamp}-p5!` })
  const iddSession = iddLogin.json?.data?.session_token ?? iddLogin.json?.token ?? iddLogin.json?.data?.token ?? iddLogin.json?.access_token
  if (!iddSession) throw new Error(`IDD 登录失败: ${JSON.stringify(iddLogin.json).slice(0, 200)}`)
  const iddTok = await api(IDD, 'POST', '/api/auth/tokens', { name: `tsa-accept-${stamp}`, expires_in_days: 2 }, iddSession)
  const iddToken = iddTok.json?.token ?? iddTok.json?.data?.token ?? iddTok.json?.api_key
  if (!iddToken) throw new Error(`IDD token 铸造失败: ${JSON.stringify(iddTok.json).slice(0, 250)}`)
  const iddVerify = await api(IDD, 'GET', '/api/auth/me', undefined, iddToken)
  save('phase-s-idd-token.json', { username: iddStamp, verifyStatus: iddVerify.status, verifyBody: iddVerify.json })
  writeFileSync(join(PRIVATE, 'idd-token.txt'), iddToken)
  log(`IDD token 已铸造并验证(status=${iddVerify.status})`)

  // ---- 铸 RAG token(后端 /api/v1 路由;web 层同源代理) ----
  const ragStamp = `tsa_${stamp}`
  let ragToken = null
  const ragAttempts = []
  for (const base of [RAG_BACKEND, RAG_WEB]) {
    const reg = await api(base, 'POST', '/api/v1/auth/register', { username: ragStamp, password: `Rag-${stamp}-k8!`, email: `${ragStamp}@aw.local` })
    const login = await api(base, 'POST', '/api/v1/auth/login', { username: ragStamp, password: `Rag-${stamp}-k8!` })
    const session = login.json?.token ?? login.json?.access_token
    ragAttempts.push({ base, regStatus: reg.status, loginStatus: login.status, hasSession: Boolean(session) })
    if (!session) continue
    const tok = await api(base, 'POST', '/api/v1/auth/tokens', { name: `tsa-accept-${stamp}` }, session)
    ragToken = tok.json?.token ?? tok.json?.api_key
    if (ragToken) { ragAttempts.push({ base, tokenStatus: tok.status }); break }
  }
  if (!ragToken) throw new Error(`RAG token 铸造失败: ${JSON.stringify(ragAttempts)}`)
  save('phase-s-rag-token.json', { username: ragStamp, attempts: ragAttempts })
  writeFileSync(join(PRIVATE, 'rag-token.txt'), ragToken)
  log('RAG token 已铸造')

  // ---- 热配两桥 ----
  const patch = await api(BASE, 'PATCH', '/api/system/settings', {
    'plugins.diag-bridge.token': iddToken,
    'plugins.diag-bridge.contract': 'auto',
    'plugins.diag-bridge.results_enabled': true,
    'plugins.rag-bridge.token': ragToken,
  }, admin.token)
  save('phase-s-settings-patch.json', { status: patch.status, body: patch.json })
  if (patch.status !== 200) throw new Error(`热配失败: ${JSON.stringify(patch.json).slice(0, 250)}`)
  log('插件桥热配完成')

  // ---- 插件 health / 清单 / 工具面 ----
  const diagHealth = await api(BASE, 'GET', '/api/plugins/diag-bridge/health', undefined, admin.token)
  const ragHealth = await api(BASE, 'GET', '/api/plugins/rag-bridge/health', undefined, admin.token)
  save('phase-s-plugin-health.json', { diag: diagHealth.json, rag: ragHealth.json })
  const diagOk = diagHealth.json?.token?.accepted === true && diagHealth.json?.remote?.status === 'ok'
  const ragOk = ragHealth.json?.backend?.ok === true && ragHealth.json?.web?.ok === true
  if (!diagOk) throw new Error(`diag-bridge health 未绿: ${JSON.stringify(diagHealth.json).slice(0, 350)}`)
  if (!ragOk) throw new Error(`rag-bridge health 未绿: ${JSON.stringify(ragHealth.json).slice(0, 350)}`)
  const plugins = await api(BASE, 'GET', '/api/workshop/plugins', undefined, admin.token)
  const plist = plugins.json?.data?.plugins ?? plugins.json?.plugins ?? []
  const failures = plist.filter(p => (p.failures ?? []).length > 0)
  save('phase-s-plugins.json', { count: plist.length, enabled: plist.filter(p => p.enabled).map(p => p.name), failures: failures.map(p => ({ name: p.name, failures: p.failures })) })
  if (failures.length > 0) throw new Error(`插件有 failures: ${JSON.stringify(failures).slice(0, 350)}`)
  const tools = await api(BASE, 'GET', '/api/workshop/tools', undefined, admin.token)
  const toolList = tools.json?.data?.tools ?? tools.json?.tools ?? []
  const names = toolList.map(t => t.name ?? t)
  const counts = {
    total: names.length,
    bridgeToolCount: BRIDGE_TOOLS.filter(n => names.includes(n)).length,
    bridgeTools: BRIDGE_TOOLS.filter(n => names.includes(n)),
  }
  save('phase-s-tools.json', counts)
  log(`插件=${plist.length} failures=0 | 工具总数=${counts.total} 桥工具=${counts.bridgeToolCount}`)

  console.log('PHASE-S-RESULT ' + JSON.stringify({ ok: true, port: AW_PORT, tools: counts.total, bridges: counts.bridgeToolCount, diagContract: diagHealth.json?.contract }))
}

async function main() {
  // ---- 外部服务预检(不重复启动) ----
  const precheck = {}
  for (const [name, base, path] of [['idd', IDD, '/api/health'], ['rag-backend', RAG_BACKEND, '/api/v1/health'], ['rag-web', RAG_WEB, '/api/health']]) {
    const h = await api(base, 'GET', path, undefined, undefined, 8000)
    precheck[name] = { status: h.status, ok: h.status === 200 }
  }
  log(`外部服务预检: idd=${precheck.idd.ok} rag-backend=${precheck['rag-backend'].ok} rag-web=${precheck['rag-web'].ok}`)
  save('phase-s-external-health.json', precheck)

  // ---- detached 启动 AW / 断点续跑 ----
  let health = await api(BASE, 'GET', '/api/health', undefined, undefined, 6000)
  if (await resumeIfNeeded(health)) return
  if (health.status === 200 && health.json?.data?.status === 'ok') {
    throw new Error(`:3021 已有实例(version=${health.json?.data?.version})但缺本轮私有记录,拒绝复用非本轮 home`)
  }
  if (existsSync(join(HOME, 'data'))) throw new Error(`${HOME} 已有数据,拒绝脏 home(请手动轮换)`)
  log('detached 启动 AW(:3021, 全新 home)…')
  const env = {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: HOME,
    PORT: String(AW_PORT),
    NUXT_SESSION_PASSWORD: SESSION_PASSWORD,
    BACKUP_DISABLED: '1',
    AW_ALLOW_PRIVATE_OUTBOUND: '1',
    NO_PROXY: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
  }
  const child = spawn(process.execPath, [join(REPO, 'scripts', '_audit', 'detached-start.mjs'), '--port', String(AW_PORT), '--wait', '75', '--log', LOG, '--cwd', REPO], {
    cwd: REPO, env, stdio: 'inherit',
  })
  const exitCode = await new Promise((res) => child.on('exit', (c) => res(c)))
  if (exitCode !== 0) {
    const tail = existsSync(LOG) ? readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-25).join('\n') : '(无日志)'
    throw new Error(`detached 启动失败(exit=${exitCode})\n${tail}`)
  }
  const pid = readFileSync(LOG + '.pid', 'utf8').trim()
  writeFileSync(join(PRIVATE, 'aw-instance.json'), JSON.stringify({ pid, port: AW_PORT, home: HOME, log: LOG, startedAt: new Date().toISOString() }, null, 1))
  log(`AW pid=${pid} 已落私有记录`)

  // ---- 健康门(status=ok && workshop=ready && version) ----
  let ready = null
  for (let i = 0; i < 40; i++) {
    health = await api(BASE, 'GET', '/api/health', undefined, undefined, 6000)
    const d = health.json?.data
    if (health.status === 200 && d?.status === 'ok' && d?.workshop === 'ready') { ready = d; break }
    await sleep(3000)
  }
  if (!ready) throw new Error(`健康门未过: ${JSON.stringify(health.json).slice(0, 350)}`)
  if (ready.version !== VERSION) throw new Error(`版本不符: 实例=${ready.version} 期望=${VERSION}(需先 npm run build)`)
  save('phase-s-aw-health.json', { pid, port: AW_PORT, home: HOME, health: ready })
  log(`AW 就绪 version=${ready.version} workshop=${ready.workshop}`)

  // ---- 注册 admin + 第二账号(首注册自动关闸 → 开 → 注册 → 关回) ----
  const stamp = Date.now().toString(36)
  const adminReg = await api(BASE, 'POST', '/api/users/register', { name: 'TSA Admin', email: `tsa-admin-${stamp}@aw.local`, password: `TsaAdmin-${stamp}-9x!` })
  if (adminReg.status !== 200 || !adminReg.json?.data?.token) throw new Error(`admin 注册失败: ${JSON.stringify(adminReg.json).slice(0, 250)}`)
  const admin = { token: adminReg.json.data.token, id: adminReg.json.data.user?.id, role: adminReg.json.data.user?.role, email: `tsa-admin-${stamp}@aw.local` }
  const openReg = await api(BASE, 'PATCH', '/api/system/settings', { 'security.allowRegistration': true }, admin.token)
  if (openReg.status !== 200) throw new Error(`开启注册失败: ${JSON.stringify(openReg.json).slice(0, 250)}`)
  const secondReg = await api(BASE, 'POST', '/api/users/register', { name: 'TSA Reviewer', email: `tsa-reviewer-${stamp}@aw.local`, password: `TsaReview-${stamp}-7m!` })
  await api(BASE, 'PATCH', '/api/system/settings', { 'security.allowRegistration': false }, admin.token)
  if (secondReg.status !== 200 || !secondReg.json?.data?.token) throw new Error(`第二账号注册失败: ${JSON.stringify(secondReg.json).slice(0, 250)}`)
  const second = { token: secondReg.json.data.token, id: secondReg.json.data.user?.id, role: secondReg.json.data.user?.role, email: `tsa-reviewer-${stamp}@aw.local` }
  save('phase-s-accounts.json', { admin: { id: admin.id, role: admin.role, email: admin.email }, second: { id: second.id, role: second.role, email: second.email } })
  writeFileSync(join(PRIVATE, 'aw-tokens.json'), JSON.stringify({ admin: admin.token, second: second.token }, null, 1))
  log(`账号: admin=${admin.role} reviewer=${second.role}`)

  await mintAndConfigure(admin)
}

await main().catch((e) => {
  console.error(`[phase-s] FAILED: ${e.message}`)
  save('phase-s-ABORT.json', { error: e.message, at: new Date().toISOString() })
  process.exitCode = 1
})
