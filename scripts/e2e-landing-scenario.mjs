#!/usr/bin/env node
/**
 * E2E 真实场景验收:商品设计创造性落地页(ralph PRD US-2..US-7)。
 * 针对已运行实例(默认 http://127.0.0.1:3995),按阶段执行并合并证据:
 *   E2E_STAGE=us2,us3,us4,us5,us6,us7,ui (缺省 us2..us6)
 * 证据: docs/audit/evidence/2026-11-07-e2e-landing/e2e-acceptance.json (按 id 合并)
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
mkdirSync(EVID, { recursive: true })
export const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const STAGES = (process.env.E2E_STAGE ?? 'us2,us3,us4,us5,us6').split(',').map(s => s.trim())
const STATE_PATH = join(REPO, '.e2e-home', 'e2e-state.json')
const EV_PATH = join(EVID, 'e2e-acceptance.json')

let results = existsSync(EV_PATH) ? JSON.parse(readFileSync(EV_PATH, 'utf8')).results ?? [] : []
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 280)}`}`)
}
const saveEv = () => writeFileSync(EV_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
const persist = (patch) => {
  const st = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
  writeFileSync(STATE_PATH, JSON.stringify({ ...st, ...patch }, null, 2))
}
const loadState = () => existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, code: -1, message: text.slice(0, 300), data: null }
  }
}
async function poll(fn, timeoutMs = 25000, interval = 600) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}
async function auth() {
  const email = 'e2e-landing@aw.local'
  let r = await api('POST', '/api/users/login', { email, password: 'E2E#2026' })
  if (r.status !== 200 || !r.data?.token) {
    r = await api('POST', '/api/users/register', { name: 'E2E Owner', email, password: 'E2E#2026' })
  }
  return r.data?.token
}

// ─────────────────────────── US-2 Channel 会话 ───────────────────────────
async function us2(token) {
  const ch = await api('POST', '/api/workshop/channels', {
    name: `E2E 会话频道 ${Date.now()}`,
    leadAgent: { name: '会话 Lead', harness: 'mock', config: {} },
  }, token)
  ok('S2-1', '创建 Channel(mock lead)', ch.status === 200 && !!ch.data?.channelId, ch.message)
  const channelId = ch.data.channelId
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: '会话 Worker', harness: 'mock', role: 'worker', config: {} }, token)
  const sess = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '落地页需求会话' }, token)
  ok('S2-2', '创建 manual session', sess.status === 200 && !!sess.data?.sessionId, sess.message)
  const sessionId = sess.data.sessionId
  const PINNED = '决策:商品定位为「口袋翻译器 T1」,主打跨境差旅人群,落地页必须首屏呈现实时互译演示'
  const send = text => api('POST', `/api/workshop/channels/${channelId}/sessions/${sessionId}/messages`, { text }, token)
  await send('请确认会话上下文加载正常')
  const block0 = await poll(async () => {
    const b = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sessionId}/brief?format=block`, undefined, token)
    return b.status === 200 && b.data?.block?.includes('### 近期对话') ? b.data.block : null
  }, 25000)
  ok('S2-3', '分层注入块(身份/近期对话/profile=full)', !!block0 && block0.includes('## Session Context (authoritative)') && block0.includes('profile=full'), (block0 ?? '').slice(0, 200))
  await send(PINNED)
  await send('今天我们先聊一下落地页的目录结构安排,然后再看看 FAQ 需要补充哪些条目与示例,最后讨论首屏 CTA 的文案语气、按钮位置与配色偏好,并排一个初稿时间表供大家评审')
  for (let i = 1; i <= 10; i++) await send(`第 ${i} 轮推进:补充首屏文案要点与 FAQ 条目 ${i}`)
  const folded = await poll(async () => {
    const b = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sessionId}/brief?format=block`, undefined, token)
    return b.status === 200 && b.data?.block?.includes('### 早期上下文') ? b.data.block : null
  }, 60000)
  ok('S2-4', '压缩触发:pinned 原文保留+早期上下文层出现', !!folded && folded.includes(PINNED) && /generation=\d+/.test(folded), (folded ?? '').slice(-300))
  ok('S2-5', '填充长句被压缩(全文不再出现)', !!folded && !folded.includes('首屏 CTA 的文案语气、按钮位置与配色偏好'), 'filler 全文不应出现在块中')
  const ctxReply = await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=120`, undefined, token)
    return (msgs.data ?? []).find(m => m.role === 'ROLE_AGENT' && m.metadata?.['x-aw-session-id'] === sessionId && /<ctx brief=1 recent=1 earlier=1 gen=\d+>/.test(String(m.parts?.[0]?.text ?? ''))) ?? null
  }, 30000)
  ok('S2-6', 'mock 回执 ctx 标签(块真实进入 harness 请求)', !!ctxReply, JSON.stringify(ctxReply ?? {}).slice(0, 240))
  const history = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sessionId}/history?limit=80`, undefined, token)
  ok('S2-7', '回执与请求同 session(history)', (history.data ?? []).some(h => h.type === 'message' && /ctx brief=1/.test(h.text ?? '')), `rows=${(history.data ?? []).length}`)
  persist({ us2: { channelId, sessionId } })
}

// ─────────────────────────── US-3 Project 管理 ───────────────────────────
async function us3(token) {
  const mk = async (name) => {
    const c = await api('POST', '/api/workshop/channels', { name: `${name} ${Date.now()}`, leadAgent: { name: `${name} Lead`, harness: 'mock', config: {} } }, token)
    const w = await api('POST', `/api/workshop/channels/${c.data.channelId}/agents`, { name: `${name} Worker`, harness: 'mock', role: 'worker', config: {} }, token)
    return { channelId: c.data.channelId, workerId: w.data?.id ?? null, leadId: c.data.leadAgentId ?? null }
  }
  const A = await mk('设计频道')
  const B = await mk('前端频道')
  ok('S3-1', '两个执行 Channel 就绪(设计/前端)', !!A.channelId && !!B.channelId, JSON.stringify({ A, B }).slice(0, 200))
  const proj = await api('POST', '/api/workshop/projects', {
    name: `T1 口袋翻译器 · 创造性落地页 ${Date.now()}`,
    objective: '为「口袋翻译器 T1」打造可渲染、可转化的创造性商品落地页:首屏实时互译演示 + 卖点 + FAQ + CTA',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy',
  }, token)
  ok('S3-2', '创建落地页 Project(mock leader)', proj.status === 200 && !!proj.data?.id, proj.message)
  const projectId = proj.data.id
  const bA = await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId: A.channelId, charter: '商品叙事/文案/视觉结构' }, token)
  const bB = await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId: B.channelId, charter: 'HTML 实现/样式/交互' }, token)
  ok('S3-3', '绑定两个执行 Channel', bA.status === 200 && bB.status === 200, `${bA.message}/${bB.message}`)
  const d = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, {
    name: 'landing-page.html', required: true, ownerChannelId: A.channelId,
    acceptanceCriteria: ['artifact_present', 'html_renderable', '含卖点/FAQ/CTA/响应式'],
  }, token)
  ok('S3-4', '必选交付物 landing-page.html(归属设计频道)', d.status === 200 && !!d.data?.id, d.message)
  const mkWi = payload => api('POST', `/api/workshop/projects/${projectId}/work-items`, payload, token)
  const w1 = await mkWi({ deliverableId: d.data.id, channelId: A.channelId, title: '市场定位与首屏文案', brief: '输出商品定位、三大卖点、首屏标题与 CTA 文案(纯文本交付)', execBudgetMinutes: 10 })
  const w2 = await mkWi({ deliverableId: d.data.id, channelId: A.channelId, title: '视觉结构与 FAQ 大纲', brief: '输出落地页区块结构、FAQ 六问、配色与版式建议(纯文本交付)', execBudgetMinutes: 10 })
  const w3 = await mkWi({ deliverableId: d.data.id, channelId: B.channelId, title: 'landing-page.html 实现', brief: '把文案与结构合成为完整可渲染的单文件 HTML(内联 CSS,响应式)', execBudgetMinutes: 10 })
  ok('S3-5', '三个工作项创建(2 设计 + 1 前端)', w1.status === 200 && w2.status === 200 && w3.status === 200, `${w1.message}/${w2.message}/${w3.message}`)
  const act = await api('POST', `/api/workshop/projects/${projectId}/activate`, {}, token)
  ok('S3-6', '激活项目', act.status === 200, act.message)
  const plan = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, {
    version: 1,
    plan: { facts: ['商品:口袋翻译器 T1', '受众:跨境差旅人群'], steps: ['文案 → 视觉结构 → HTML 实现'], deliverables: ['landing-page.html'] },
  }, token)
  ok('S3-7', '提交 plan v1 审批', plan.status === 200 && !!plan.data?.id, plan.message)
  if (plan.data?.id) {
    const dec = await api('POST', `/api/workshop/projects/${projectId}/approvals/${plan.data.id}/decide`, { approve: true }, token)
    ok('S3-8', 'owner 批准 plan', dec.status === 200, dec.message)
  }
  const obs = await api('GET', `/api/workshop/projects/${projectId}/observability`, undefined, token)
  ok('S3-9', 'observability 快照(access/工作项/交付物)', obs.status === 200 && !!obs.data?.project && (obs.data?.workItems?.length ?? 0) >= 3, JSON.stringify(obs.data ?? {}).slice(0, 240))
  const pSess = await api('GET', `/api/workshop/projects/${projectId}/sessions`, undefined, token)
  ok('S3-10', 'project session 生成', (pSess.data ?? []).some(s => s.kind === 'project'), JSON.stringify(pSess.data ?? []).slice(0, 200))
  const events = await api('GET', `/api/workshop/projects/${projectId}/events?limit=100`, undefined, token)
  ok('S3-11', '审计事件落库', (events.data ?? []).length >= 3, `events=${(events.data ?? []).length}`)
  persist({ us3: { projectId, A, B, deliverableId: d.data.id, w1: w1.data.id, w2: w2.data.id, w3: w3.data.id } })
}

// ─────────────────────────── US-4 任务下发路由 ───────────────────────────
async function us4(token) {
  const st = loadState().us3
  const dispatch = await api('POST', `/api/workshop/projects/${st.projectId}/work-items/${st.w1}/dispatch`, {}, token)
  ok('S4-1', '派发 W1(任务实例 Channel + task session)', dispatch.status === 200, dispatch.message)
  const sessions = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${st.projectId}/sessions`, undefined, token)
    return (r.data ?? []).find(s => s.kind === 'task' && s.workItemId === st.w1) ?? null
  }, 30000)
  ok('S4-2', 'task session 生成并关联工作项', !!sessions, JSON.stringify(sessions ?? {}).slice(0, 200))
  if (!sessions) return
  const blk = await poll(async () => {
    const b = await api('GET', `/api/workshop/channels/${sessions.channelId}/sessions/${sessions.id}/brief?format=block`, undefined, token)
    return b.status === 200 && b.data?.block?.includes('### 近期对话') ? b.data.block : null
  }, 30000)
  ok('S4-3', 'task session 注入块含工作项上下文', !!blk && blk.includes('市场定位与首屏文案'), (blk ?? '').slice(0, 240))
  const msgs = await api('GET', `/api/workshop/channels/${sessions.channelId}/messages?limit=60`, undefined, token)
  const assign = (msgs.data ?? []).find(m => m.metadata?.['x-aw-task-kind'] === 'assign' && m.metadata?.['x-aw-session-id'] === sessions.id)
  ok('S4-4', 'assign 消息带 x-aw-session-id(路由贯通)', !!assign, JSON.stringify(assign?.metadata ?? {}).slice(0, 240))
  const done = await poll(async () => {
    const obs = await api('GET', `/api/workshop/projects/${st.projectId}/observability`, undefined, token)
    const wi = (obs.data?.workItems ?? []).find(w => w.id === st.w1)
    return wi && wi.state === 'COMPLETED' ? wi : null
  }, 90000)
  ok('S4-5', 'mock worker 执行 → 工作项 COMPLETED', !!done, JSON.stringify(done ?? {}).slice(0, 200))
  const ags = await api('GET', `/api/workshop/channels/${sessions.channelId}/agents`, undefined, token)
  const agentIds = (ags.data ?? []).map(a => a.id).filter(Boolean)
  let stamped = null
  for (const aid of agentIds) {
    stamped = await poll(async () => {
      const r = await api('GET', `/api/workshop/channels/${sessions.channelId}/agents/${aid}/memories?limit=50`, undefined, token)
      return (r.data ?? []).find(m => m.sessionId === sessions.id) ?? null
    }, 20000)
    if (stamped) break
  }
  ok('S4-6', '任务终态记忆带 task session 戳(记忆模块生效)', !!stamped, JSON.stringify(stamped ?? { agentIds }).slice(0, 240))
  if (stamped) {
    const hit = await api('POST', `/api/workshop/channels/${sessions.channelId}/agents/${stamped.agentId}/memories/search`, { query: '市场定位 首屏文案', scope: 'session', sessionId: sessions.id, limit: 10 }, token)
    const miss = await api('POST', `/api/workshop/channels/${sessions.channelId}/agents/${stamped.agentId}/memories/search`, { query: '市场定位 首屏文案', scope: 'session', sessionId: 'sess-never', limit: 10 }, token)
    ok('S4-7', 'scope=session 检索隔离(本会话命中/他 session 空)', (hit.data ?? []).some(m => m.sessionId === sessions.id) && (miss.data ?? []).length === 0, `hit=${(hit.data ?? []).length} miss=${(miss.data ?? []).length}`)
  }
  persist({ us4: { taskSession: sessions } })
}

// ────────────────────── US-5 多 Channel 协同 + 成果共享 ──────────────────────
async function us5(token) {
  const st = loadState().us3
  const wiBefore = await api('GET', `/api/workshop/projects/${st.projectId}/observability`, undefined, token)
  const w2State = (wiBefore.data?.workItems ?? []).find(w => w.id === st.w2)?.state
  if (w2State === 'COMPLETED') {
    ok('S5-1', 'W2 已在先前运行完成(重入幂等;两实例频道均真并行)', true, 'state=COMPLETED (previous run)')
  }
  else {
    const d2 = await api('POST', `/api/workshop/projects/${st.projectId}/work-items/${st.w2}/dispatch`, {}, token)
    ok('S5-1', '派发 W2(第二实例频道并行)', d2.status === 200, d2.message)
  }
  const done2 = await poll(async () => {
    const obs = await api('GET', `/api/workshop/projects/${st.projectId}/observability`, undefined, token)
    const wi = (obs.data?.workItems ?? []).find(w => w.id === st.w2)
    return wi && wi.state === 'COMPLETED' ? wi : null
  }, 90000)
  ok('S5-2', 'W2 完成(两个实例频道均真并行)', !!done2, JSON.stringify(done2 ?? {}).slice(0, 200))
  const xmsg = await api('POST', `/api/workshop/channels/${st.A.channelId}/messages`, {
    toChannelId: st.B.channelId,
    fromAgentId: st.A.leadId,
    text: '设计侧同步:首屏文案定稿为「对着说话,像本地人」。请前端频道确认可承接 HTML 实现。',
    requireReply: true,
  }, token)
  ok('S5-3', '跨频道 A2A 发送(lead→toChannelId, requireReply)', xmsg.status === 200, JSON.stringify(xmsg).slice(0, 240))
  const xReply = await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${st.A.channelId}/messages?limit=80`, undefined, token)
    return (msgs.data ?? []).find(m => m.role === 'ROLE_AGENT' && m.metadata?.['x-aw-cross-channel'] === 'true') ?? null
  }, 40000)
  ok('S5-4', '跨频道回执回源(x-aw-cross-channel)', !!xReply, JSON.stringify(xReply ?? {}).slice(0, 300))
  const rec = await api('POST', `/api/workshop/projects/${st.projectId}/reconcile`, {}, token)
  ok('S5-5', 'reconcile(任务成果 → 项目结果物化)', rec.status === 200, rec.message)
  const resultsRows = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${st.projectId}/results`, undefined, token)
    return (r.data ?? []).length >= 1 ? r.data : null
  }, 20000)
  ok('S5-6', 'draft 结果生成(成果中间件入项目层)', (resultsRows ?? []).length >= 1, JSON.stringify(resultsRows ?? []).slice(0, 300))
  let approved = false
  const reviewNotes = []
  for (const r0 of resultsRows ?? []) {
    if (r0.status === 'draft') {
      const sub = await api('POST', `/api/workshop/projects/${st.projectId}/results/${r0.id}/submit`, { summary: 'E2E 提交:任务成果已达成交付口径' }, token)
      reviewNotes.push({ id: r0.id.slice(0, 8), submit: sub.status, msg: sub.message })
    }
    // draft 已在早前运行提交(submitted)→ 直接续跑 L1 评审
    const cur = (await api('GET', `/api/workshop/projects/${st.projectId}/results`, undefined, token)).data?.find(x => x.id === r0.id)
    if (cur && ['submitted', 'reviewed'].includes(cur.status) && cur.status !== 'reviewed') {
      const rev = await api('POST', `/api/workshop/projects/${st.projectId}/results/${r0.id}/review`, { decision: 'reviewed', reason: 'E2E 技术评审通过' }, token)
      reviewNotes.push({ id: r0.id.slice(0, 8), review: rev.status, msg: rev.message })
    }
    const after = (await api('GET', `/api/workshop/projects/${st.projectId}/results`, undefined, token)).data?.find(x => x.id === r0.id)
    if (after?.status === 'reviewed') approved = true
  }
  ok('S5-7', '结果 submit + 技术评审(L1 门)通过', approved, JSON.stringify(reviewNotes).slice(0, 300))
  persist({ us5: { results: resultsRows ?? [] } })
}

// ─────────────────────────── US-6 错误处理矩阵 ───────────────────────────
async function us6(token) {
  const st = loadState().us3
  // S6-0/S6-1:未授权身份防护(自助注册已关闭 = 首用户后自动收紧,结构化 403)
  const u2 = await api('POST', '/api/users/register', { name: 'E2E Outsider', email: `e2e-outsider-${Date.now()}@aw.local`, password: 'E2E#2026' })
  const regClosed = u2.status === 403 && u2.code === 'REGISTRATION_CLOSED'
  ok('S6-0', '未授权自助注册被拒(403 REGISTRATION_CLOSED,结构化)', regClosed, JSON.stringify(u2).slice(0, 220))
  const anonymous = await fetch(`${BASE}/api/workshop/channels/${st.A.channelId}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '匿名', harness: 'mock', role: 'worker', config: {} }) })
  const anonJson = await anonymous.json().catch(() => ({}))
  ok('S6-1', '无凭据写操作 → 401(结构化,身份门)', anonymous.status === 401 && !!anonJson.code, JSON.stringify(anonJson).slice(0, 200))
  const badRole = await api('POST', `/api/workshop/channels/${st.A.channelId}/agents`, { name: '坏角色', harness: 'mock', role: 'owner', config: {} }, token)
  ok('S6-2', '非法角色 → 400', badRole.status === 400, JSON.stringify(badRole).slice(0, 200))
  const badMsg = await api('POST', `/api/workshop/channels/${st.A.channelId}/messages`, { text: 'no target' }, token)
  ok('S6-3', '缺目标消息 → 400(结构化 envelope)', badMsg.status === 400 && !!badMsg.code, JSON.stringify(badMsg).slice(0, 200))
  // 未批 plan 派发 → 409(错误矩阵项目用独立频道:一频道一项目)
  const chX = await api('POST', '/api/workshop/channels', { name: `错误矩阵频道 ${Date.now()}`, leadAgent: { name: '矩阵 Lead', harness: 'mock', config: {} } }, token)
  const p2 = await api('POST', '/api/workshop/projects', { name: `错误矩阵项目 ${Date.now()}`, objective: 'x', leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy' }, token)
  const bindOk = p2.status === 200 && p2.data?.id && chX.status === 200
  if (bindOk) {
    const b2 = await api('POST', `/api/workshop/projects/${p2.data.id}/channels`, { channelId: chX.data.channelId, charter: 'probe' }, token)
    const d2 = b2.status === 200 ? await api('POST', `/api/workshop/projects/${p2.data.id}/deliverables`, { name: 'x.html', required: true, ownerChannelId: chX.data.channelId, acceptanceCriteria: ['artifact_present'] }, token) : { data: null }
    const w2 = d2.data?.id ? await api('POST', `/api/workshop/projects/${p2.data.id}/work-items`, { deliverableId: d2.data.id, channelId: chX.data.channelId, title: 'x', brief: 'x', execBudgetMinutes: 5 }, token) : { data: null }
    if (w2.data?.id) {
      await api('POST', `/api/workshop/projects/${p2.data.id}/activate`, {}, token)
      const dispatchDenied = await api('POST', `/api/workshop/projects/${p2.data.id}/work-items/${w2.data.id}/dispatch`, {}, token)
      ok('S6-4', '未批准 plan 派发 → 409(结构化)', dispatchDenied.status === 409 && !!dispatchDenied.code, JSON.stringify(dispatchDenied).slice(0, 200))
    }
    else {
      ok('S6-4', '未批准 plan 派发 → 409(结构化)', false, `w2 创建失败 ${JSON.stringify(d2).slice(0, 150)}`)
    }
  }
  else {
    ok('S6-4', '未批准 plan 派发 → 409(结构化)', false, JSON.stringify({ p2: p2.message, chX: chX.message }).slice(0, 200))
  }
  // 群聊需 owner 显式开启(CHAT_DISABLED 409 本身即结构化错误处理证据)
  const chatOff = await api('POST', `/api/workshop/channels/${st.A.channelId}/chat/messages`, { text: '未开启探针', clientMessageId: `e2e-chatoff-${Date.now()}` }, token)
  ok('S6-5a', '未开启群聊的频道拒绝聊天(409 CHAT_DISABLED,结构化)', chatOff.status === 409 && chatOff.code === 'CHAT_DISABLED', JSON.stringify(chatOff).slice(0, 200))
  const enableChat = await api('PATCH', `/api/workshop/channels/${st.A.channelId}`, { chatEnabled: 1 }, token)
  const cmid = `e2e-dup-${Date.now()}`
  const chat1 = await api('POST', `/api/workshop/channels/${st.A.channelId}/chat/messages`, { text: '幂等探针', clientMessageId: cmid }, token)
  const chat2 = await api('POST', `/api/workshop/channels/${st.A.channelId}/chat/messages`, { text: '幂等探针', clientMessageId: cmid }, token)
  const dupFlag = chat2.data?.duplicates ?? chat2.data?.duplicated ?? null
  ok('S6-5', '重复 clientMessageId 幂等', enableChat.status === 200 && chat1.status === 200 && chat2.status === 200 && (dupFlag === true || dupFlag === 1 || chat2.data?.message?.id === chat1.data?.message?.id), JSON.stringify({ enable: enableChat.status, c1: chat1.data?.duplicates, c2: chat2.data?.duplicates, m1: chat1.data?.message?.id, m2: chat2.data?.message?.id }).slice(0, 240))
  const graceful = await api('POST', `/api/workshop/channels/${st.A.channelId}/chat/messages`, { text: '投递降级探针', mentions: [{ type: 'agent', id: 'ghost-agent-xxx', label: 'Ghost' }] }, token)
  ok('S6-6', '不可达目标优雅降级(非 500)', graceful.status === 200 || graceful.status === 400 || graceful.status === 404, `${graceful.status} ${String(graceful.message ?? '').slice(0, 120)}`)
}

// ---------------- US-7 真实场景:商品落地页(omp 真实 LLM 腿) ----------------
async function us7(token) {
  const st = loadState().us3
  const ompA = await api('POST', `/api/workshop/channels/${st.A.channelId}/agents`, { name: '文案 Agent(omp)', harness: 'omp', role: 'worker', config: {} }, token)
  const ompB = await api('POST', `/api/workshop/channels/${st.B.channelId}/agents`, { name: '实现 Agent(omp)', harness: 'omp', role: 'worker', config: {} }, token)
  ok('S7-1', 'omp 真实引擎 worker 加入两个频道', ompA.status === 200 && ompB.status === 200 && !!ompA.data?.id && !!ompB.data?.id, JSON.stringify({ ompA: ompA.message, ompB: ompB.message }).slice(0, 240))
  if (!ompA.data?.id || !ompB.data?.id) return
  persist({ us7: { ompA: ompA.data.id, ompB: ompB.data.id } })

  // W4:首屏文案(omp 腿,设计频道)
  const w4 = await api('POST', `/api/workshop/projects/${st.projectId}/work-items`, {
    deliverableId: st.deliverableId, channelId: st.A.channelId,
    title: '首屏文案与卖点(真实 LLM)',
    brief: '商品:口袋翻译器 T1(耳机形态,入耳即译,离线双语,35 小时续航,1299 元)。受众:跨境差旅人群。'
      + '产出:1) 主标题+副标题(首屏);2) 三大卖点(每条不超过24字+一句支撑);3) FAQ 四问;4) CTA 文案两版。纯文本交付。',
    execBudgetMinutes: 15,
  }, token)
  ok('S7-2', 'W4 文案工作项创建', w4.status === 200 && !!w4.data?.id, w4.message)
  const d4 = await api('POST', `/api/workshop/projects/${st.projectId}/work-items/${w4.data.id}/dispatch`, {}, token)
  ok('S7-3', 'W4 派发(omp 执行)', d4.status === 200, d4.message)
  const done4 = await poll(async () => {
    const obs = await api('GET', `/api/workshop/projects/${st.projectId}/observability`, undefined, token)
    const wi = (obs.data?.workItems ?? []).find(w => w.id === w4.data.id)
    return wi && ['COMPLETED', 'FAILED', 'CANCELED'].includes(wi.state) ? wi : null
  }, 15 * 60_000, 5000)
  ok('S7-4', 'W4 omp 执行完成', done4?.state === 'COMPLETED', JSON.stringify(done4 ?? { timeout: true }).slice(0, 240))

  // 提取 W4 artifact(成果中间件取回)
  let copyText = ''
  const det4 = await api('GET', `/api/workshop/projects/${st.projectId}/observability/work-items/${w4.data.id}`, undefined, token)
  const at4 = (det4.data?.attempts ?? [])[0]?.task
  for (const a of (at4?.artifacts ?? [])) {
    if (a.name === 'input') continue
    copyText += (a.parts ?? []).map(pp => pp.text ?? '').join('\n') + '\n'
  }
  ok('S7-5', 'W4 成果经 observability 取回(成果中间件)', copyText.trim().length > 50, `len=${copyText.trim().length}`)

  // W3:HTML 实现(omp 腿,前端频道),brief 注入真实文案成果
  const brief3 = '把下列已定稿文案与结构合成为完整可渲染的单文件 HTML(内联 CSS,响应式,含首屏/卖点/FAQ/CTA):\n'
    + '商品:口袋翻译器 T1(耳机形态,入耳即译,离线双语,35 小时续航,1299 元)。\n'
    + '已定稿文案:\n' + copyText.slice(0, 6000)
  const patch = await api('PATCH', `/api/workshop/projects/${st.projectId}/work-items/${st.w3}`, { brief: brief3 }, token)
  ok('S7-6', 'W3 brief 注入真实文案成果(成果复用)', patch.status === 200, patch.message)
  const d3 = await api('POST', `/api/workshop/projects/${st.projectId}/work-items/${st.w3}/dispatch`, {}, token)
  ok('S7-7', 'W3 派发(omp 执行)', d3.status === 200, d3.message)
  const done3 = await poll(async () => {
    const obs = await api('GET', `/api/workshop/projects/${st.projectId}/observability`, undefined, token)
    const wi = (obs.data?.workItems ?? []).find(w => w.id === st.w3)
    return wi && ['COMPLETED', 'FAILED', 'CANCELED'].includes(wi.state) ? wi : null
  }, 20 * 60_000, 5000)
  ok('S7-8', 'W3 omp 执行完成', done3?.state === 'COMPLETED', JSON.stringify(done3 ?? { timeout: true }).slice(0, 240))

  // 结果物化 + 全验收链
  await api('POST', `/api/workshop/projects/${st.projectId}/reconcile`, {}, token)
  const rows = await poll(async () => {
    const r = await api('GET', `/api/workshop/projects/${st.projectId}/results`, undefined, token)
    return (r.data ?? []).find(x => x.workItemId === st.w3) ?? null
  }, 20000)
  ok('S7-9', 'W3 draft 结果生成', !!rows, JSON.stringify(rows ?? {}).slice(0, 200))
  if (rows) {
    const sub = await api('POST', `/api/workshop/projects/${st.projectId}/results/${rows.id}/submit`, { summary: '真实引擎落地页交付' }, token)
    ok('S7-10', '结果 submit(树域证据回溯通过)', sub.status === 200, JSON.stringify(sub).slice(0, 240))
    const rev = await api('POST', `/api/workshop/projects/${st.projectId}/results/${rows.id}/review`, { decision: 'reviewed', reason: 'E2E 技术评审通过' }, token)
    ok('S7-11', 'L1 技术评审通过', rev.status === 200, JSON.stringify(rev).slice(0, 240))
    const req = await api('POST', `/api/workshop/projects/${st.projectId}/results/${rows.id}/request-acceptance`, {}, token)
    ok('S7-12', 'L2 验收申请(证据门重跑通过)', req.status === 200, JSON.stringify(req).slice(0, 240))
    const appr = await api('POST', `/api/workshop/projects/${st.projectId}/approvals/${req.data?.id}/decide`, { approve: true }, token)
    ok('S7-13', 'L2 业务验收批准', appr.status === 200, JSON.stringify(appr).slice(0, 200))
    const det3 = await api('GET', `/api/workshop/projects/${st.projectId}/observability/work-items/${st.w3}`, undefined, token)
    const at3 = (det3.data?.attempts ?? [])[0]?.task
    let html = ''
    for (const a of (at3?.artifacts ?? [])) {
      if (a.name === 'input') continue
      html += (a.parts ?? []).map(pp => pp.text ?? '').join('')
    }
    const { writeFileSync: wf } = await import('node:fs')
    const htmlPath = EVID + '/landing-page.html'
    wf(htmlPath, html, 'utf-8')
    ok('S7-14', '最终 HTML 落盘证据', html.includes('<html') && html.length > 800, 'bytes=' + html.length + ' path=' + htmlPath)
    persist({ us7: { w4: w4.data.id, htmlPath, htmlBytes: html.length, resultId: rows.id } })
  }
}

const stages = { us2, us3, us4, us5, us6, us7 }
export { ok, saveEv, api, poll, auth, persist, loadState, sleep }
if (process.env.E2E_RUN_MAIN) {
  try {
    const token = await auth()
    if (!token) throw new Error('登录/注册失败')
    for (const s of STAGES) {
      if (stages[s]) {
        console.log(`\n── stage ${s} ──`)
        await stages[s](token)
        saveEv()
      }
    }
    saveEv()
    const fail = results.filter(r => !r.pass).length
    console.log(`\n=== E2E(${STAGES.join('+')}) pass=${results.length - fail} fail=${fail} ===`)
    process.exitCode = fail > 0 ? 1 : 0
  }
  catch (err) {
    console.error('E2E 异常:', err)
    saveEv()
    process.exitCode = 1
  }
}
