#!/usr/bin/env node
/**
 * 记忆运行时贯通(PR-B)实机验收:session 作用域记忆端到端。
 *  M1 运行时戳:session 对话 → clone 的 peer 交换记忆带 session 戳(运行时自动记录路径)。
 *  M2 检索隔离:search API scope=session + sessionId → 只回本会话行;他 session → 空。
 *  M3 工具桥:REST invoke save_memory(无 session 态)→ 频道级;scope=session 无上下文时明确拒绝。
 *  M4 徽标数据:memories 列表含 sessionId(UI session 徽标数据源)。
 *
 * 运行:node scripts/session-memory-runtime-acceptance.mjs(.output 已构建;端口 3994 / 临时 AW_HOME)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = mkdtempSync(join(tmpdir(), 'aw-mem-runtime-accept-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
const PORT = 3994
const BASE = `http://127.0.0.1:${PORT}`
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-session-memory-runtime')
mkdirSync(EVID, { recursive: true })

const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NITRO_PORT: String(PORT),
    AW_MODE: 'home',
    AW_HOME: HOME,
    NUXT_SESSION_PASSWORD: 'MemRuntime#2026-acceptance',
    AW_PROMPTS_DIR: join(REPO, '.output/.AgentWorkShop/prompts'),
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let serverLog = ''
child.stdout?.on('data', (d) => {
  serverLog += String(d)
})
child.stderr?.on('data', (d) => {
  serverLog += String(d)
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    const json = JSON.parse(text)
    return { status: res.status, ...json }
  }
  catch {
    return { status: res.status, code: -1, message: text.slice(0, 300), data: null }
  }
}
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    }
    catch { /* retry */ }
    await sleep(1000)
  }
  throw new Error('server 未 ready')
}
async function poll(fn, timeoutMs = 25000, interval = 500) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}

try {
  await waitReady()
  const email = `mem-runtime-${Date.now()}@aw.local`
  const reg = await api('POST', '/api/users/register', { name: 'Mem Owner', email, password: 'Mem#2026' })
  ok('R1', '注册 owner', reg.status === 200 && !!reg.data?.token, reg.message)
  const token = reg.data?.token
  const H = { authorization: `Bearer ${token}` }

  const ch = await api('POST', '/api/workshop/channels', {
    name: `记忆作用域验收频道 ${Date.now()}`,
    leadAgent: { name: 'Lead', harness: 'mock', config: {} },
  }, token)
  ok('C1', '创建 Channel + mock lead', ch.status === 200 && !!ch.data?.channelId, ch.message)
  const channelId = ch.data?.channelId
  const worker = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: 'Worker', harness: 'mock', role: 'worker', config: {},
  }, token)
  ok('C2', '添加 mock worker', worker.status === 200 && !!worker.data?.id, worker.message)

  const sess = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '记忆作用域会话' }, token)
  ok('C3', '创建 manual session(克隆成员)', sess.status === 200 && !!sess.data?.sessionId, sess.message)
  const sessionId = sess.data?.sessionId
  const cloneId = (sess.data?.members ?? [])[0]?.cloneId
  ok('C4', 'session clone 成员存在', !!cloneId, JSON.stringify(sess.data?.members ?? []).slice(0, 200))

  // ── M1:会话对话 → 运行时 peer 交换记忆带 session 戳 ──
  const decision = '决策：本项目记忆验收采用会话作用域存储与按需检索'
  await api('POST', `/api/workshop/channels/${channelId}/sessions/${sessionId}/messages`, { text: decision }, token)
  const stamped = await poll(async () => {
    const r = await api('GET', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories?limit=50`, undefined, H)
    const rows = r.data ?? []
    return rows.find(m => m.sessionId === sessionId) ?? null
  }, 30000)
  ok('M1', '运行时自动记忆带 session 戳(peer 交换)', !!stamped, JSON.stringify(stamped ?? {}).slice(0, 300))

  // ── M2:检索隔离 ──
  await poll(async () => {
    const r = await api('POST', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories/search`, {
      query: '记忆验收 会话作用域', scope: 'session', sessionId, limit: 10,
    }, H)
    return r.status === 200 && (r.data ?? []).length > 0 ? r.data : null
  }, 20000)
  const sHit = await api('POST', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories/search`, {
    query: '记忆验收', scope: 'session', sessionId, limit: 10,
  }, H)
  ok('M2a', 'scope=session + sessionId 命中本会话行', sHit.status === 200 && (sHit.data ?? []).some(m => m.sessionId === sessionId), JSON.stringify(sHit.data ?? []).slice(0, 300))
  const sMiss = await api('POST', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories/search`, {
    query: '记忆验收', scope: 'session', sessionId: 'sess-not-exist', limit: 10,
  }, H)
  ok('M2b', '其他 session → 空(作用域隔离)', sMiss.status === 200 && (sMiss.data ?? []).length === 0, JSON.stringify(sMiss.data ?? []).slice(0, 200))
  const sAuto = await api('POST', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories/search`, {
    query: '记忆验收', scope: 'auto', sessionId, limit: 10,
  }, H)
  ok('M2c', 'auto 档 + sessionId 也可命中', sAuto.status === 200 && (sAuto.data ?? []).some(m => m.sessionId === sessionId), JSON.stringify(sAuto.data ?? []).slice(0, 200))

  // ── M3:工具桥(REST invoke,owner 用户通道;无活动回合 → 频道级 + session 档明确拒绝)──
  const invoke = (tool, args) => api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: cloneId, tool, args,
  }, H)
  const saveNoSess = await invoke('save_memory', { title: '频道级记忆', content: '跨会话有效', scope: 'private' })
  ok('M3a', 'save_memory(REST,无会话态)→ 频道级', saveNoSess.status === 200 && /频道级/.test(String(saveNoSess.data?.text ?? '')), String(saveNoSess.data?.text ?? '').slice(0, 200))
  const savedRow = await poll(async () => {
    const r = await api('GET', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories?limit=50`, undefined, H)
    return (r.data ?? []).find(m => m.title === '频道级记忆') ?? null
  }, 15000)
  ok('M3b', 'REST 落库行为频道级(sessionId 空)', !!savedRow && (savedRow.sessionId ?? '') === '', JSON.stringify(savedRow ?? {}).slice(0, 200))
  const sessSearchNoCtx = await invoke('search_memory', { query: '跨会话', scope: 'session' })
  ok('M3c', 'scope=session 无会话态 → 明确拒绝', sessSearchNoCtx.status === 200 && /没有 session 上下文/.test(String(sessSearchNoCtx.data?.text ?? '')), String(sessSearchNoCtx.data?.text ?? '').slice(0, 200))

  // ── M4:UI 徽标数据源 ──
  const listAll = await api('GET', `/api/workshop/channels/${channelId}/agents/${cloneId}/memories?limit=50`, undefined, H)
  ok('M4', 'memories 列表含 sessionId 字段(UI 徽标)', (listAll.data ?? []).every(m => typeof m === 'object' && 'sessionId' in m) && (listAll.data ?? []).length >= 2, `rows=${(listAll.data ?? []).length}`)

  const failed = results.filter(r => !r.pass).length
  const report = { generatedAt: new Date().toISOString(), base: BASE, pass: results.length - failed, fail: failed, results }
  writeFileSync(join(EVID, 'acceptance.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(EVID, 'server.log'), serverLog.slice(-20000))
  console.log(`\n=== SESSION MEMORY RUNTIME ACCEPTANCE pass=${results.length - failed} fail=${failed} ===`)
  process.exitCode = failed > 0 ? 1 : 0
}
catch (err) {
  console.error('验收异常:', err)
  writeFileSync(join(EVID, 'acceptance-error.log'), `${err?.stack ?? err}\n\n--- server ---\n${serverLog.slice(-20000)}`)
  process.exitCode = 1
}
finally {
  try {
    child.kill()
  }
  catch { /* ignore */ }
  await sleep(300)
  if (process.exitCode === 0) {
    try {
      rmSync(ROOT, { recursive: true, force: true })
    }
    catch { /* ignore */ }
  }
  process.exit(process.exitCode ?? 0)
}
