#!/usr/bin/env node
/**
 * 全生命周期实机演示(L1..L10):针对运行中的 3995 实例,
 * 以确定性 mock 引擎走完 系统功能的全生命周期,逐阶段断言并存证。
 * 证据: docs/audit/evidence/2026-11-07-system-lifecycle/lifecycle-demo.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-system-lifecycle')
mkdirSync(EVID, { recursive: true })
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const EV_PATH = join(EVID, 'lifecycle-demo.json')

let results = existsSync(EV_PATH) ? JSON.parse(readFileSync(EV_PATH, 'utf8')).results ?? [] : []
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 280)}`}`)
}
const saveEv = () => writeFileSync(EV_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
const persist = (patch) => {
  const p = join(REPO, '.e2e-home', 'lifecycle-state.json')
  const st = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  writeFileSync(p, JSON.stringify({ ...st, ...patch }, null, 2))
}
const loadState = () => {
  const p = join(REPO, '.e2e-home', 'lifecycle-state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, code: -1, message: text.slice(0, 300), data: null }
  }
}
async function poll(fn, timeoutMs = 30000, interval = 600) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}

// ── L1 身份与工作区 ──
async function L1(token) {
  const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null)
  ok('L1-1', '实例健康', health?.data?.status === 'ok', JSON.stringify(health?.data ?? {}).slice(0, 120))
  const me = await api('GET', '/api/users/me', undefined, token)
  ok('L1-2', '身份可读(登录态)', me.status === 200 && !!me.data?.id, JSON.stringify(me.data ?? {}).slice(0, 120))
  let ws = (await api('GET', '/api/workshop/workspaces', undefined, token)).data ?? []
  if (!ws.length) {
    const created = await api('POST', '/api/workshop/workspaces', { name: '生命周期演示工作区' }, token)
    ws = [created.data]
  }
  ok('L1-3', '工作区可用', ws.length > 0 && !!ws[0].id, `ws=${ws[0]?.id?.slice(0, 8)}`)
  persist({ L1: { wsId: ws[0].id } })
}

// ── L2 Channel 生命周期 ──
async function L2(token) {
  const ch = await api('POST', '/api/workshop/channels', {
    name: `生命周期演示频道 ${Date.now()}`,
    leadAgent: { name: '演示 Lead', harness: 'mock', config: {} },
  }, token)
  ok('L2-1', '创建 Channel(lead 内建)', ch.status === 200 && !!ch.data?.channelId, ch.message)
  const channelId = ch.data.channelId
  const worker = await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: '演示 Worker', harness: 'mock', role: 'worker', config: {} }, token)
  ok('L2-2', '添加 worker', worker.status === 200 && !!worker.data?.id, worker.message)
  const chatOff = await api('POST', `/api/workshop/channels/${channelId}/chat/messages`, { text: 'probe', clientMessageId: `lc-off-${Date.now()}` }, token)
  ok('L2-3', '群聊默认关闭(409 CHAT_DISABLED,结构化)', chatOff.status === 409 && chatOff.code === 'CHAT_DISABLED', JSON.stringify(chatOff).slice(0, 160))
  const enable = await api('PATCH', `/api/workshop/channels/${channelId}`, { chatEnabled: 1 }, token)
  const chatOn = await api('POST', `/api/workshop/channels/${channelId}/chat/messages`, { text: '生命周期演示第一条群聊', clientMessageId: `lc-on-${Date.now()}` }, token)
  ok('L2-4', 'owner 开启群聊后可用', enable.status === 200 && chatOn.status === 200, JSON.stringify(chatOn.data ?? {}).slice(0, 160))
  const detail = await api('GET', `/api/workshop/channels/${channelId}`, undefined, token)
  ok('L2-5', '频道详情可读', detail.status === 200 && !!detail.data?.id, '')
  persist({ L2: { channelId, workerId: worker.data?.id } })
}

// ── L3 会话生命周期(创建→对话→压缩→关闭→目录) ──
async function L3(token) {
  const st = loadState().L2
  const sess = await api('POST', `/api/workshop/channels/${st.channelId}/sessions`, { title: '生命周期会话' }, token)
  ok('L3-1', '创建 manual session(克隆成员)', sess.status === 200 && !!sess.data?.sessionId, sess.message)
  const sessionId = sess.data.sessionId
  const PINNED = '决策:生命周期演示以确定性 mock 引擎走完全链'
  const send = text => api('POST', `/api/workshop/channels/${st.channelId}/sessions/${sessionId}/messages`, { text }, token)
  await send('开始生命周期演示')
  await send(PINNED)
  for (let i = 1; i <= 10; i++) await send(`生命周期演示推进 ${i}:校验注入与压缩`)
  const block = await poll(async () => {
    const b = await api('GET', `/api/workshop/channels/${st.channelId}/sessions/${sessionId}/brief?format=block`, undefined, token)
    return b.status === 200 && b.data?.block?.includes('### 早期上下文') && b.data.block.includes(PINNED) && !b.data.block.includes('校验注入与压缩,然后再看看后续') ? b.data.block : null
  }, 60000)
  ok('L3-2', '会话注入:分层+压缩+pinned 保留(稳定终态)', !!block && block.includes('## Session Context (authoritative)'), (block ?? '').slice(-200))
  const ctx = await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${st.channelId}/messages?limit=100`, undefined, token)
    return (msgs.data ?? []).find(m => m.role === 'ROLE_AGENT' && m.metadata?.['x-aw-session-id'] === sessionId && /<ctx brief=1 recent=1 earlier=1 gen=\d+>/.test(String(m.parts?.[0]?.text ?? ''))) ?? null
  }, 30000)
  ok('L3-3', '注入到达 harness(ctx 标签 earlier=1)', !!ctx, JSON.stringify(ctx ?? {}).slice(0, 200))
  const closed = await api('POST', `/api/workshop/channels/${st.channelId}/sessions/${sessionId}/close`, { reason: '生命周期演示收口' }, token)
  ok('L3-4', '关闭 session', closed.status === 200, closed.message)
  const catalog = await api('GET', `/api/workshop/channels/${st.channelId}/sessions`, undefined, token)
  const row = (catalog.data ?? []).find(s => s.id === sessionId)
  ok('L3-5', '目录标记 closed 且 brief 可读', row?.status === 'closed' || row?.brief?.status === 'closed', JSON.stringify(row ?? {}).slice(0, 160))
  persist({ L3: { sessionId } })
}

// ── L4 Project 计划期 ──
async function L4(token) {
  const mk = async (name) => {
    const c = await api('POST', '/api/workshop/channels', { name: `${name} ${Date.now()}`, leadAgent: { name: `${name} Lead`, harness: 'mock', config: {} } }, token)
    const w = await api('POST', `/api/workshop/channels/${c.data.channelId}/agents`, { name: `${name} Worker`, harness: 'mock', role: 'worker', config: {} }, token)
    return { channelId: c.data.channelId, workerId: w.data?.id, leadId: c.data.leadAgentId }
  }
  const A = await mk('生产频道')
  const B = await mk('协同频道')
  const proj = await api('POST', '/api/workshop/projects', {
    name: `全生命周期演示项目 ${Date.now()}`,
    objective: '走完 创建→计划→派发→执行→协同→交付→验收→完成→归档 全生命周期',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy',
  }, token)
  ok('L4-1', '创建项目', proj.status === 200 && !!proj.data?.id, proj.message)
  const projectId = proj.data.id
  const bA = await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId: A.channelId, charter: '生产' }, token)
  const bB = await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId: B.channelId, charter: '协同' }, token)
  ok('L4-2', '绑定双频道', bA.status === 200 && bB.status === 200, `${bA.message}/${bB.message}`)
  const d = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, {
    name: 'lifecycle-demo.html', required: true, ownerChannelId: A.channelId,
    acceptanceCriteria: ['artifact_present', 'html_renderable'],
  }, token)
  ok('L4-3', '必选交付物', d.status === 200 && !!d.data?.id, d.message)
  const w1 = await api('POST', `/api/workshop/projects/${projectId}/work-items`, { deliverableId: d.data.id, channelId: A.channelId, title: '内容产出', brief: '产出演示内容(纯文本)', execBudgetMinutes: 10 }, token)
  const w2 = await api('POST', `/api/workshop/projects/${projectId}/work-items`, { deliverableId: d.data.id, channelId: B.channelId, title: '页面合成', brief: '合成演示页面(纯文本)', execBudgetMinutes: 10 }, token)
  ok('L4-4', '工作项×2(跨频道)', w1.status === 200 && w2.status === 200, `${w1.message}/${w2.message}`)
  const act = await api('POST', `/api/workshop/projects/${projectId}/activate`, {}, token)
  ok('L4-5', '激活', act.status === 200, act.message)
  const plan = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, { version: 1, plan: { facts: ['lifecycle demo'], steps: ['内容→合成'] } }, token)
  ok('L4-6', 'plan v1 提交', plan.status === 200 && !!plan.data?.id, plan.message)
  if (plan.data?.id) {
    const dec = await api('POST', `/api/workshop/projects/${projectId}/approvals/${plan.data.id}/decide`, { approve: true }, token)
    ok('L4-7', 'plan 批准', dec.status === 200, dec.message)
  }
  persist({ L4: { projectId, A, B, deliverableId: d.data.id, w1: w1.data.id, w2: w2.data.id } })
}

// ── L5 执行期 ──
async function L5(token) {
  const st = loadState().L4
  const d1 = await api('POST', `/api/workshop/projects/${st.projectId}/work-items/${st.w1}/dispatch`, {}, token)
  ok('L5-1', '派发 W1(实例频道+task session)', d1.status === 200, d1.message)
  const d2 = await api('POST', `/api/workshop/projects/${st.projectId}/work-items/${st.w2}/dispatch`, {}, token)
  ok('L5-2', '派发 W2(第二实例频道真并行)', d2.status === 200, d2.message)
  const done = await poll(async () => {
    const o = await api('GET', `/api/workshop/projects/${st.projectId}/observability`, undefined, token)
    const w1 = (o.data?.workItems ?? []).find(w => w.id === st.w1)
    const w2 = (o.data?.workItems ?? []).find(w => w.id === st.w2)
    return w1?.state === 'COMPLETED' && w2?.state === 'COMPLETED' ? { w1, w2 } : null
  }, 120000)
  ok('L5-3', '双工作项 COMPLETED(真并行执行)', !!done, JSON.stringify(done ?? {}).slice(0, 200))
  const sessions = await api('GET', `/api/workshop/projects/${st.projectId}/sessions`, undefined, token)
  const taskSessions = (sessions.data ?? []).filter(s => s.kind === 'task')
  ok('L5-4', 'task session 目录(≥2)', taskSessions.length >= 2, `count=${taskSessions.length}`)
  let memStamped = false
  for (const s of taskSessions) {
    const ags = await api('GET', `/api/workshop/channels/${s.channelId}/agents`, undefined, token)
    for (const a of (ags.data ?? [])) {
      const r = await api('GET', `/api/workshop/channels/${s.channelId}/agents/${a.id}/memories?limit=30`, undefined, token)
      if ((r.data ?? []).some(m => m.sessionId === s.id)) memStamped = true
    }
  }
  ok('L5-5', '执行记忆带 session 戳(全实例频道扫描)', memStamped, '')
  persist({ L5: { taskSessionCount: taskSessions.length } })
}

// ── L6 协作期 ──
async function L6(token) {
  const st = loadState().L4
  const x = await api('POST', `/api/workshop/channels/${st.A.channelId}/messages`, {
    toChannelId: st.B.channelId, fromAgentId: st.A.leadId,
    text: '生命周期演示:生产侧已产出内容,请协同侧确认。', requireReply: true,
  }, token)
  ok('L6-1', '跨频道 A2A 发送', x.status === 200, x.message)
  const reply = await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${st.A.channelId}/messages?limit=80`, undefined, token)
    return (msgs.data ?? []).find(m => m.role === 'ROLE_AGENT' && m.metadata?.['x-aw-cross-channel'] === 'true') ?? null
  }, 40000)
  ok('L6-2', '跨频道回执回源', !!reply, JSON.stringify(reply ?? {}).slice(0, 200))
}

// ── L7 交付期:全部 draft 走 agent 提交链(authorAgent 持证 → owner 可批 L2)→ 交付物级验收 ──
async function acceptDraft(token, projectId, draftId, workItemId) {
  const det = await api('GET', `/api/workshop/projects/${projectId}/observability/work-items/${workItemId}`, undefined, token)
  const taskId = (det.data?.attempts ?? [{}])[0]?.channelTaskId
  const obsRow = (await api('GET', `/api/workshop/projects/${projectId}/observability`, undefined, token)).data?.workItems.find(w => w.id === workItemId)
  const ags = await api('GET', `/api/workshop/channels/${obsRow?.instanceChannelId}/agents`, undefined, token)
  const lead = (ags.data ?? []).find(a => a.role === 'lead')
  const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: lead.id, tool: 'project_submit_result',
    args: { result_id: draftId, task_id: taskId, summary: '生命周期演示:agent 提交', payload: { demo: 'lifecycle' } },
  }, token)
  const invText = String(inv.data?.result?.text ?? '')
  const rev = await api('POST', `/api/workshop/projects/${projectId}/results/${draftId}/review`, { decision: 'reviewed', reason: 'L1 技术评审通过' }, token)
  const req = await api('POST', `/api/workshop/projects/${projectId}/results/${draftId}/request-acceptance`, {}, token)
  let apprOk = false
  if (req.data?.id) {
    const appr = await api('POST', `/api/workshop/projects/${projectId}/approvals/${req.data.id}/decide`, { approve: true }, token)
    apprOk = appr.status === 200
  }
  return { invText, rev, req, apprOk }
}

async function L7(token) {
  const st = loadState().L4
  await api('POST', `/api/workshop/projects/${st.projectId}/reconcile`, {}, token)
  const early = (await api('GET', `/api/workshop/projects/${st.projectId}/results`, undefined, token)).data ?? []
  ok('L7-1', 'reconcile 物化 draft 结果(≥2)', early.length >= 2, `count=${early.length}`)
  let accepted = 0
  for (const r0 of early) {
    if (r0.status !== 'draft') continue
    const r = await acceptDraft(token, st.projectId, r0.id, r0.workItemId)
    if (r.apprOk) accepted++
    await sleep(300)
  }
  ok('L7-2', '全部 draft 走 agent 提交链并通过 L2(每工作项一个 approved 槽)', accepted === early.filter(x => x.status === 'draft').length && accepted >= 2, `accepted=${accepted}`)
  const deliverable = (await api('GET', `/api/workshop/projects/${st.projectId}/deliverables`, undefined, token)).data?.find(d => d.id === st.deliverableId)
  ok('L7-3', '交付物级验收翻转 approved(全部工作项各持 approved 结果)', deliverable?.status === 'approved', `status=${deliverable?.status}`)
}

// ── L8 收口期(complete → archive;terminate 走独立项目) ──
async function L8(token) {
  const st = loadState().L4
  const comp = await api('POST', `/api/workshop/projects/${st.projectId}/complete`, {}, token)
  ok('L8-1', '项目完成审批创建(门禁通过)', comp.status === 200, comp.message)
  if (comp.data?.id) {
    const dec = await api('POST', `/api/workshop/projects/${st.projectId}/approvals/${comp.data.id}/decide`, { approve: true }, token)
    ok('L8-2', '完成审批通过 → 项目 completed', dec.status === 200, dec.message)
  }
  const arch = await api('POST', `/api/workshop/projects/${st.projectId}/archive`, {}, token)
  ok('L8-3', '归档(completed → archived)', arch.status === 200, arch.message)
  // 治理:归档为终态,补需求被正确拒绝(continue 重开语义由单测 project-continue 覆盖)
  const contLate = await api('POST', `/api/workshop/projects/${st.projectId}/continue`, { message: '生命周期演示:归档后补需求探针' }, token)
  ok('L8-4', '归档项目 continue 被正确拒绝(409 终态治理)', contLate.status === 409 && !!contLate.code, JSON.stringify(contLate).slice(0, 160))
  // 终止路径:独立一次性项目
  const chX = await api('POST', '/api/workshop/channels', { name: `终止演示频道 ${Date.now()}`, leadAgent: { name: '终止 Lead', harness: 'mock', config: {} } }, token)
  const p2 = await api('POST', '/api/workshop/projects', { name: `终止演示项目 ${Date.now()}`, objective: 'x', leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy' }, token)
  await api('POST', `/api/workshop/projects/${p2.data.id}/channels`, { channelId: chX.data.channelId, charter: 'x' }, token)
  const d2 = await api('POST', `/api/workshop/projects/${p2.data.id}/deliverables`, { name: 'x.html', required: true, ownerChannelId: chX.data.channelId, acceptanceCriteria: ['artifact_present'] }, token)
  const w2 = await api('POST', `/api/workshop/projects/${p2.data.id}/work-items`, { deliverableId: d2.data.id, channelId: chX.data.channelId, title: 'x', brief: 'x', execBudgetMinutes: 5 }, token)
  await api('POST', `/api/workshop/projects/${p2.data.id}/activate`, {}, token)
  const plan2 = await api('POST', `/api/workshop/projects/${p2.data.id}/plan/request-approval`, { version: 1, plan: { facts: ['terminate demo'] } }, token)
  if (plan2.data?.id) await api('POST', `/api/workshop/projects/${p2.data.id}/approvals/${plan2.data.id}/decide`, { approve: true }, token)
  await api('POST', `/api/workshop/projects/${p2.data.id}/work-items/${w2.data.id}/dispatch`, {}, token)
  const term = await api('POST', `/api/workshop/projects/${p2.data.id}/terminate`, { reason: '生命周期演示:运行中终止' }, token)
  ok('L8-5', '运行中项目终止(级联终结)', term.status === 200, term.message)
  const p2r = await api('GET', `/api/workshop/projects/${p2.data.id}`, undefined, token)
  ok('L8-6', '终止后状态 canceled(终态)', p2r.data?.status === 'canceled', `status=${p2r.data?.status}`)
  persist({ L8: { terminatedProjectId: p2.data.id } })
}

// ── L9 治理:暂停/恢复/归档状态机复核 ──
async function L9(token) {
  const st = loadState().L4
  const cont = await api('POST', `/api/workshop/projects/${st.projectId}/continue`, { message: '生命周期演示:归属探针(幂等复核)' }, token)
  ok('L9-1', '归档终态:重复 continue 仍 409(幂等治理)', cont.status === 409 && !!cont.code, JSON.stringify(cont).slice(0, 160))
}

// ── L10 治理探针 ──
async function L10(token) {
  const st = loadState().L4
  const badRole = await api('POST', `/api/workshop/channels/${st.A.channelId}/agents`, { name: '坏角色', harness: 'mock', role: 'owner', config: {} }, token)
  ok('L10-1', '非法角色 400', badRole.status === 400, JSON.stringify(badRole).slice(0, 140))
  const anon = await fetch(`${BASE}/api/workshop/channels/${st.A.channelId}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ok('L10-2', '匿名写 401', anon.status === 401, `status=${anon.status}`)
  const p3 = await api('POST', '/api/workshop/projects', { name: `治理探针 ${Date.now()}`, objective: 'x', leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy' }, token)
  const ch3 = await api('POST', '/api/workshop/channels', { name: `治理探针频道 ${Date.now()}`, leadAgent: { name: 'L', harness: 'mock', config: {} } }, token)
  await api('POST', `/api/workshop/projects/${p3.data.id}/channels`, { channelId: ch3.data.channelId, charter: 'x' }, token)
  const d3 = await api('POST', `/api/workshop/projects/${p3.data.id}/deliverables`, { name: 'x.html', required: true, ownerChannelId: ch3.data.channelId, acceptanceCriteria: ['artifact_present'] }, token)
  const w3 = await api('POST', `/api/workshop/projects/${p3.data.id}/work-items`, { deliverableId: d3.data.id, channelId: ch3.data.channelId, title: 'x', brief: 'x', execBudgetMinutes: 5 }, token)
  await api('POST', `/api/workshop/projects/${p3.data.id}/activate`, {}, token)
  const denied = await api('POST', `/api/workshop/projects/${p3.data.id}/work-items/${w3.data.id}/dispatch`, {}, token)
  ok('L10-3', '未批 plan 派发 409', denied.status === 409 && !!denied.code, JSON.stringify(denied).slice(0, 140))
  const events = await api('GET', `/api/workshop/projects/${st.projectId}/events?scope=all&limit=200`, undefined, token)
  const types = new Set((events.data ?? []).map(e => e.type))
  const need = new Set(['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.approved'])
  ok('L10-3b', '审计事件覆盖演示项目全生命周期(派发/完成/提交/评审/批准)', [...need].every(n => types.has(n)), `missing=${[...need].filter(n => !types.has(n)).join(',')}`)
  const termId = loadState().L8?.terminatedProjectId
  const tev = termId ? (await api('GET', `/api/workshop/projects/${termId}/events?scope=all&limit=100`, undefined, token)).data ?? [] : []
  ok('L10-4', '终止项目审计含 project.terminated(级联可审计)', tev.some(e => e.type === 'project.terminated'), `events=${tev.length}`)
}

const stages = { L1, L2, L3, L4, L5, L6, L7, L8, L9, L10 }
try {
  const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
  if (!token) throw new Error('login failed')
  for (const [name, fn] of Object.entries(stages)) {
    console.log(`\n── ${name} ──`)
    await fn(token)
    saveEv()
  }
  saveEv()
  const fail = results.filter(r => !r.pass).length
  console.log(`\n=== LIFECYCLE DEMO pass=${results.length - fail} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}
catch (err) {
  console.error('演示异常:', err)
  saveEv()
  process.exitCode = 1
}
