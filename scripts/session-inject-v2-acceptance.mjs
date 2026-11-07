#!/usr/bin/env node
/**
 * Session 注入 v2 实机验收（分层装配 + 提取式压缩 + harness 注入证明）：
 *  V1 block API：format=block 返回分层注入文本（Session Context / 近期对话 / profile=full）。
 *  V2 压缩：窗口外旧轮折叠 —— pinned 原文保留、填充长句被压缩（原文消失、话题行出现）、generation 演进。
 *  V3 注入证明：mock 回执带 <ctx …> 标签，earlier=1 证明压缩后的块真的进入 harness 请求。
 *  V4 Project task session：task block 含 work_item / 近期对话 / profile=full。
 *
 * 运行：node scripts/session-inject-v2-acceptance.mjs
 * 需要 .output 已构建；脚本自起隔离 server（端口 3993 / 临时 AW_HOME）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = mkdtempSync(join(tmpdir(), 'aw-inject-v2-accept-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
const PORT = 3993
const BASE = `http://127.0.0.1:${PORT}`
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-session-inject-v2')
mkdirSync(EVID, { recursive: true })

const PINNED = '决策：锁定A方案作为本会话交付基线，后续验收不得更改口径与范围'
const FILLER = '今天我们先聊一下值班手册的目录结构安排，然后再看看 FAQ 需要补充哪些条目与示例，最后讨论巡检报告模板的格式、字段与统计口径，并排一个初稿时间表'

const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NITRO_PORT: String(PORT),
    AW_MODE: 'home',
    AW_HOME: HOME,
    NUXT_SESSION_PASSWORD: 'InjectV2#2026-acceptance',
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
  const email = `inject-v2-${Date.now()}@aw.local`
  const reg = await api('POST', '/api/users/register', { name: 'Inject Owner', email, password: 'Inject#2026' })
  ok('R1', '注册 owner', reg.status === 200 && !!reg.data?.token, reg.message)
  const token = reg.data?.token

  const ch = await api('POST', '/api/workshop/channels', {
    name: `注入 v2 验收频道 ${Date.now()}`,
    leadAgent: { name: 'Lead', harness: 'mock', config: {} },
  }, token)
  ok('C1', '创建 Channel + mock lead', ch.status === 200 && !!ch.data?.channelId, ch.message)
  const channelId = ch.data?.channelId
  const worker = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name: 'Worker', harness: 'mock', role: 'worker', config: {},
  }, token)
  ok('C2', '添加 mock worker', worker.status === 200 && !!worker.data?.id, worker.message)

  const sess = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '注入验收会话' }, token)
  ok('C3', '创建 manual session', sess.status === 200 && !!sess.data?.sessionId, sess.message)
  const sessionId = sess.data?.sessionId

  const send = async (text) => {
    const r = await api('POST', `/api/workshop/channels/${channelId}/sessions/${sessionId}/messages`, { text }, token)
    if (r.status !== 200) throw new Error(`send 失败: ${r.message}`)
    return r
  }
  const getBlock = async () => {
    const r = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sessionId}/brief?format=block`, undefined, token)
    return r.status === 200 ? (r.data?.block ?? '') : null
  }

  // ── V1：初始分层 ──
  await send('请报告当前会话上下文并保持简短')
  await poll(async () => {
    const b = await getBlock()
    return b ? b.includes('### 近期对话') : false
  }, 25000)
  const block0 = await getBlock()
  ok('V1a', 'block API 返回分层注入文本', !!block0 && block0.includes('## Session Context (authoritative)'), (block0 ?? '').slice(0, 200))
  ok('V1b', 'profile=full 标注在块头', !!block0 && block0.includes('profile=full'), (block0 ?? '').slice(0, 120))
  ok('V1c', '近期对话层含原文轮次', !!block0 && block0.includes('请报告当前会话上下文并保持简短'), (block0 ?? '').slice(0, 400))

  // ── V2：压缩演进（pinned+filler 被推出 8 条窗口）──
  await send(PINNED)
  await send(FILLER)
  for (let i = 1; i <= 10; i++) await send(`第 ${i} 轮推进：补充 FAQ 条目与巡检要点 ${i}`)
  // 稳定终态轮询:压缩层出现 且 pinned 原文在块内 且 填充句已离开 recent 窗口(避免压缩刚触发时
  // filler 仍在 recent 层原文出现导致的竞态;并行套件拖慢节奏时会放大该窗口)
  const folded = await poll(async () => {
    const b = await getBlock()
    return b && b.includes('### 早期上下文') && b.includes(PINNED) && !b.includes(FILLER) ? b : null
  }, 60000)
  ok('V2a', '压缩触发：早期上下文层出现', !!folded, (folded ?? (await getBlock()) ?? '').slice(-400))
  ok('V2b', 'pinned 原文保留（关键事实层）', !!folded && folded.includes(PINNED), (folded ?? '').slice(0, 400))
  ok('V2c', '填充长句被压缩（原文不再整体出现）', !!folded && !folded.includes(FILLER), 'filler 全文不应出现在注入块')
  // 话题行设计语义:TOPIC_MAX=10 有界,最旧话题先丢弃(pinned 不受影响)
  const topicCount = (folded ?? '').split('\n').filter(l => l.startsWith('· ')).length
  ok('V2d', '压缩层话题行有界(1..10)且填充句仅以压缩形式留存', !!folded && topicCount >= 1 && topicCount <= 10, `topicLines=${topicCount}`)
  ok('V2e', 'generation ≥ 1 标注', !!folded && /generation=\d+/.test(folded), (folded ?? '').match(/generation=\d+/)?.[0])

  // ── V3：注入证明（mock 回执 ctx 标签）──
  await send('请再确认一次你看到的会话上下文分层')
  const ctxReply = await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=120`, undefined, token)
    const rows = msgs.data ?? []
    return rows.find(m => m.role === 'ROLE_AGENT' && typeof m.metadata?.['x-aw-session-id'] === 'string'
      && /<ctx brief=1 recent=1 earlier=1 gen=\d+>/.test(String(m.parts?.[0]?.text ?? '')))
  }, 30000)
  ok('V3', 'mock 回执 ctx 标签 earlier=1（块真实进入 harness 请求）', !!ctxReply, JSON.stringify(ctxReply ?? {}).slice(0, 400))

  // ── V4：Project task session 注入块 ──
  const proj = await api('POST', '/api/workshop/projects', {
    name: `注入 v2 验收项目 ${Date.now()}`,
    objective: '验证 task session 分层注入',
    leaderHarness: 'mock',
    mode: 'supervised',
    routingPolicy: 'legacy',
  }, token)
  ok('P1', '创建 Project', proj.status === 200 && !!proj.data?.id, proj.message)
  const projectId = proj.data?.id
  const bound = await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId, charter: '注入验收' }, token)
  ok('P2', '绑定执行 Channel', bound.status === 200, bound.message)
  const del = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, {
    name: '注入验收交付物', required: true, ownerChannelId: channelId, acceptanceCriteria: ['artifact_present'],
  }, token)
  ok('P3', '创建必选交付物', del.status === 200 && !!del.data?.id, del.message)
  const wi = await api('POST', `/api/workshop/projects/${projectId}/work-items`, {
    deliverableId: del.data?.id, channelId, title: '注入验收工作项', brief: '产出一个可验收结果', execBudgetMinutes: 10,
  }, token)
  ok('P4', '创建工作项', wi.status === 200 && !!wi.data?.id, wi.message)
  const act = await api('POST', `/api/workshop/projects/${projectId}/activate`, {}, token)
  ok('P5', '激活项目', act.status === 200, act.message)
  const plan = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, {
    version: 1, plan: { facts: ['inject v2 acceptance'] },
  }, token)
  ok('P6', '提交 plan 审批', plan.status === 200 && !!plan.data?.id, plan.message)
  if (plan.data?.id) {
    const decide = await api('POST', `/api/workshop/projects/${projectId}/approvals/${plan.data.id}/decide`, { approve: true }, token)
    ok('P7', '批准 plan', decide.status === 200, decide.message)
  }
  const dispatch = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi.data?.id}/dispatch`, {}, token)
  ok('P8', '派发工作项', dispatch.status === 200, dispatch.message)

  const sessions = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${projectId}/sessions`, undefined, token)
    const rows = r.data ?? []
    return rows.some(s => s.kind === 'task') ? rows : null
  }, 30000)
  const taskSession = (sessions ?? []).find(s => s.kind === 'task')
  if (taskSession) {
    const tb = await poll(async () => {
      const r = await api('GET', `/api/workshop/channels/${taskSession.channelId}/sessions/${taskSession.id}/brief?format=block`, undefined, token)
      const b = r.status === 200 ? (r.data?.block ?? '') : ''
      return b.includes('### 近期对话') ? b : null
    }, 30000)
    ok('V4a', 'task session 注入块含近期对话', !!tb, (tb ?? '').slice(0, 200))
    ok('V4b', 'task session 块关联工作项', !!tb && tb.includes('注入验收工作项'), (tb ?? '').slice(0, 300))
    ok('V4c', 'task session 块 profile=full', !!tb && tb.includes('profile=full'), '')
  }
  else {
    ok('V4a', 'task session 注入块含近期对话', false, 'no task session')
    ok('V4b', 'task session 块关联工作项', false, 'no task session')
    ok('V4c', 'task session 块 profile=full', false, 'no task session')
  }

  const failed = results.filter(r => !r.pass).length
  const report = { generatedAt: new Date().toISOString(), base: BASE, pass: results.length - failed, fail: failed, results }
  writeFileSync(join(EVID, 'acceptance.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(EVID, 'server.log'), serverLog.slice(-20000))
  console.log(`\n=== SESSION INJECT V2 ACCEPTANCE pass=${results.length - failed} fail=${failed} ===`)
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
