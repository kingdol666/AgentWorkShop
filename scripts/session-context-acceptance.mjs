#!/usr/bin/env node
/**
 * Session Context A 方案实机验收：
 *  1. Channel manual session：创建 → 发消息 → clone 回执落同一 session → brief/history。
 *  2. Project session：项目创建生成 project session；work item 派发生成 task session（session_id 贯通）。
 *
 * 运行：node scripts/session-context-acceptance.mjs
 * 需要 .output 已构建；脚本自起隔离 server（端口 3991 / 临时 AW_HOME）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = mkdtempSync(join(tmpdir(), 'aw-session-accept-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
const PORT = 3991
const BASE = `http://127.0.0.1:${PORT}`
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-session-context')
mkdirSync(EVID, { recursive: true })

const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NITRO_PORT: String(PORT),
    AW_MODE: 'home',
    AW_HOME: HOME,
    NUXT_SESSION_PASSWORD: 'SessionContext#2026-acceptance',
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
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
async function poll(fn, timeoutMs = 20000, interval = 500) {
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
  const email = `session-${Date.now()}@aw.local`
  const reg = await api('POST', '/api/users/register', { name: 'Session Owner', email, password: 'Session#2026' })
  ok('R1', '注册 owner', reg.status === 200 && !!reg.data?.token, reg.message)
  const token = reg.data?.token

  // ===== Channel manual session =====
  const ch = await api('POST', '/api/workshop/channels', {
    name: `Session 验收频道 ${Date.now()}`,
    leadAgent: { name: 'Lead', harness: 'mock', config: {} },
  }, token)
  ok('C1', '创建 Channel + mock lead', ch.status === 200 && !!ch.data?.channelId, ch.message)
  const channelId = ch.data?.channelId
  const worker = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: 'Worker', harness: 'mock', role: 'worker', config: {},
  }, token)
  ok('C2', '添加 mock worker', worker.status === 200 && !!worker.data?.id, worker.message)

  const sess = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '验收会话' }, token)
  ok('C3', '创建 manual session（克隆成员）', sess.status === 200 && !!sess.data?.sessionId, sess.message)
  const sessionId = sess.data?.sessionId
  const members = sess.data?.members ?? []
  const cloneIds = new Set(members.map(m => m.cloneId))

  const sent = await api('POST', `/api/workshop/channels/${channelId}/sessions/${sessionId}/messages`, {
    text: '请报告当前会话上下文',
  }, token)
  ok('C4', 'session 发消息（投递给 clone）', sent.status === 200 && !!sent.data?.messageId, sent.message)

  const reply = await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=100`, undefined, token)
    const rows = msgs.data ?? []
    return rows.find(m => m.fromAgentId && cloneIds.has(m.fromAgentId) && m.metadata?.['x-aw-session-id'] === sessionId && m.role === 'ROLE_AGENT')
      ?? rows.find(m => m.fromAgentId && cloneIds.has(m.fromAgentId) && m.metadata?.['x-aw-session-id'] === sessionId)
  }, 25000)
  if (!reply) {
    const all = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=100`, undefined, token)
    console.log('DEBUG messages after session send:', JSON.stringify((all.data ?? []).slice(-8), null, 2).slice(0, 4000))
  }
  ok('C5', 'clone 回执落同一 session（metadata.session_id）', !!reply, JSON.stringify(reply ?? {}).slice(0, 300))

  const brief = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sessionId}/brief`, undefined, token)
  ok('C6', 'session brief 可读', brief.status === 200 && brief.data?.sessionId === sessionId, brief.message)
  ok('C7', 'brief 含最近消息/下一步', Array.isArray(brief.data?.recentMessages) && brief.data.recentMessages.length > 0 && !!brief.data?.nextStep, JSON.stringify(brief.data ?? {}).slice(0, 300))
  const history = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sessionId}/history?limit=80`, undefined, token)
  ok('C8', 'session history 有界可读', history.status === 200 && (history.data ?? []).length > 0, `rows=${(history.data ?? []).length}`)

  // ===== Project session =====
  const proj = await api('POST', '/api/workshop/projects', {
    name: `Session 验收项目 ${Date.now()}`,
    objective: '验证 project/task session 上下文',
    leaderHarness: 'mock',
    mode: 'supervised',
    routingPolicy: 'legacy',
  }, token)
  ok('P1', '创建 Project', proj.status === 200 && !!proj.data?.id, proj.message)
  const projectId = proj.data?.id

  const bound = await api('POST', `/api/workshop/projects/${projectId}/channels`, {
    channelId, charter: '验收执行频道',
  }, token)
  ok('P2', '绑定执行 Channel', bound.status === 200, bound.message)

  const del = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, {
    name: '验收交付物', required: true, ownerChannelId: channelId, acceptanceCriteria: ['artifact_present'],
  }, token)
  ok('P3', '创建必选交付物', del.status === 200 && !!del.data?.id, del.message)

  const wi = await api('POST', `/api/workshop/projects/${projectId}/work-items`, {
    deliverableId: del.data?.id,
    channelId,
    title: '验收工作项',
    brief: '产出一个可验收结果',
    execBudgetMinutes: 10,
  }, token)
  ok('P4', '创建工作项', wi.status === 200 && !!wi.data?.id, wi.message)

  const act = await api('POST', `/api/workshop/projects/${projectId}/activate`, {}, token)
  ok('P5', '激活项目', act.status === 200, act.message)

  const plan = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, {
    version: 1, plan: { facts: ['session acceptance'] },
  }, token)
  ok('P6', '提交 plan 审批', plan.status === 200 && !!plan.data?.id, plan.message)
  if (plan.data?.id) {
    const decide = await api('POST', `/api/workshop/projects/${projectId}/approvals/${plan.data.id}/decide`, { approve: true }, token)
    ok('P7', '批准 plan', decide.status === 200, decide.message)
  }

  const dispatch = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi.data?.id}/dispatch`, {}, token)
  ok('P8', '派发工作项（任务实例 Channel + session）', dispatch.status === 200, dispatch.message)

  const sessions = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${projectId}/sessions`, undefined, token)
    const rows = r.data ?? []
    return rows.length >= 2 ? rows : null
  }, 30000)
  ok('P9', 'Project session 目录含 project + task', Array.isArray(sessions) && sessions.some(s => s.kind === 'project') && sessions.some(s => s.kind === 'task'), JSON.stringify(sessions ?? []).slice(0, 500))
  const taskSession = (sessions ?? []).find(s => s.kind === 'task')
  if (taskSession) {
    const sb = await api('GET', `/api/workshop/channels/${taskSession.channelId}/sessions/${taskSession.id}/brief`, undefined, token)
    ok('P10', 'task session brief 可读', sb.status === 200 && sb.data?.kind === 'task', sb.message)
    ok('P11', 'task brief 关联工作项', sb.data?.workItemTitle === '验收工作项' || sb.data?.currentTask?.title === '验收工作项', JSON.stringify(sb.data ?? {}).slice(0, 400))
  }
  else {
    ok('P10', 'task session brief 可读', false, 'no task session')
    ok('P11', 'task brief 关联工作项', false, 'no task session')
  }

  const failed = results.filter(r => !r.pass).length
  const report = { generatedAt: new Date().toISOString(), base: BASE, pass: results.length - failed, fail: failed, results }
  writeFileSync(join(EVID, 'acceptance.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(EVID, 'server.log'), serverLog.slice(-20000))
  console.log(`\n=== SESSION CONTEXT ACCEPTANCE pass=${results.length - failed} fail=${failed} ===`)
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
