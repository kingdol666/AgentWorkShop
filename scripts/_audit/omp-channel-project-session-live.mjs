#!/usr/bin/env node
/**
 * omp-channel-project-session-live.mjs —— omp(ustc/deepseek-flash) 真实 LLM 实机验收（2026-11-09）。
 *
 * 覆盖用户诉求：「基于 ustc/deepseek-flash omp 作为 harness 做 Channel 和 project 的测试任务」，
 * 以及 session 隔离：
 *   A. Channel：omp lead 真实回复两个独立会话（session A/B），互不串话
 *   B. Project：omp leader + technical/legacy 全链；两个工作项派发到各自任务实例
 *      （独立 instance Channel + 独立 session），LLM 真实执行并交付 artifact
 *   C. 隔离断言：session id / memberMap / 实例 channel 全不同；历史与 artifact 无跨会话串扰
 *   D. 验收闭环：对账→draft→owner 提交→独立 admin L1→验收申请→L2 签核→completed
 *   E. 真实浏览器：项目中心入口 → 卡片 → 详情 → 看板/会话 → 截图
 *
 * 前置：npm run build 已产出 .output；omp CLI 可用且 models.yml 含 ustc provider。
 * 用法：node scripts/_audit/omp-channel-project-session-live.mjs [--keep]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const KEEP = process.argv.includes('--keep')
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const OUT = resolve(REPO, `docs/audit/evidence/2026-11-09-omp-channel-project-session`)
mkdirSync(OUT, { recursive: true })
const HOME = join(tmpdir(), `aw-omp-live-${STAMP}`)
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

let PORT = 0
for (const p of [3155, 3154, 3153, 3152]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1000) })
    if (r.ok) continue
  }
  catch { /* free */ }
  PORT = p
  break
}
if (!PORT) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${PORT}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.AW_UI_SCALE = process.env.AW_UI_SCALE ?? '1'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const facts = {}
const ok = (id, name, cond, detail = '') => {
  const pass = Boolean(cond)
  results.push({ id, name, pass, detail: String(detail).slice(0, 600) })
  console.log(`${pass ? '✔' : '✖'} [${id}] ${name}${detail ? ` · ${String(detail).slice(0, 260)}` : ''}`)
  return pass
}
const errMsg = e => (e?.response?.data?.message ?? e?.message ?? String(e))

async function api(method, path, body, token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}

async function waitFor(fn, { timeout = 300_000, interval = 2500, label = 'condition' } = {}) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    }
    catch (e) {
      last = e
    }
    await sleep(interval)
  }
  throw new Error(`${label} 超时 ${timeout}ms (last=${String(last?.message ?? last).slice(0, 200)})`)
}

let child = null
let browser = null

try {
  console.log(`\n=== omp/deepseek-flash Channel·Project·Session 实机验收 · port=${PORT} · home=${HOME} ===\n`)
  child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      NITRO_PORT: String(PORT),
      AW_MODE: 'home',
      AW_HOME: HOME,
      NUXT_SESSION_PASSWORD: 'OmpLive#2026-e2e-key-0123456789abcdef',
      BACKUP_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const healthy = await waitFor(async () => {
    const h = await api('GET', '/api/health', undefined, undefined, 3000).catch(() => null)
    return h?.data?.status === 'ok' && h?.data?.workshop === 'ready'
  }, { timeout: 120_000, interval: 1000, label: 'server ready' }).catch(() => false)
  ok('O1', '隔离实例启动（生产构建 + 全新 AW_HOME）', healthy, `port=${PORT}`)
  if (!healthy) throw new Error('server not ready')

  // ── 账号：owner + 独立 admin 评审 ──
  const reg = await api('POST', '/api/users/register', { name: 'omp-owner', email: 'owner@omp.local', password: 'Owner#2026' })
  const token = reg.data?.token
  const rev = await api('POST', '/api/users', { name: 'omp-reviewer', email: 'reviewer@omp.local', password: 'Review#2026', role: 'admin' }, token)
  const revLogin = await api('POST', '/api/users/login', { email: 'reviewer@omp.local', password: 'Review#2026' })
  const reviewerToken = revLogin.data?.token
  ok('O2', 'owner + 独立评审账号', Boolean(token && reviewerToken), `owner=${reg.status} reviewer=${rev.status}/${revLogin.status}`)

  // ── 引擎可用性 + 模型配置 ──
  const hs = await api('GET', '/api/workshop/harnesses', undefined, token)
  const omp = (hs.data?.harnesses ?? []).find(h => h.id === 'omp')
  ok('O3', 'omp 引擎可用', omp?.available === true, `path=${omp?.resolvedPath ?? omp?.error}`)
  facts.harness = { id: 'omp', provider: 'ustc', model: 'deepseek-flash', available: omp?.available === true }

  // ── A. Channel：omp lead + 两个独立会话 ──
  const ch = await api('POST', '/api/workshop/channels', {
    name: `omp真实频道-${STAMP.slice(-5)}`,
    description: 'omp/deepseek-flash 真实 LLM 验收频道',
    leadAgent: { name: 'OMP 执行 Lead', harness: 'omp', config: { provider: 'ustc', model: 'deepseek-flash' } },
  }, token, 60_000)
  const channelId = ch.data?.channelId
  const leadAgentId = ch.data?.leadAgentId
  ok('O4', '创建 omp Channel（模型 ustc/deepseek-flash）', ch.status === 200 && Boolean(channelId && leadAgentId),
    `channel=${channelId} lead=${leadAgentId} ${ch.message}`)
  if (!channelId) throw new Error(`channel create failed: ${ch.message}`)
  facts.channel = { id: channelId, leadAgentId }

  const agents = await api('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token)
  const leadRow = (agents.data ?? []).find(a => a.id === leadAgentId)
  ok('O5', 'Lead 运行时绑定 omp + provider/model 配置落库',
    leadRow?.harness === 'omp' && leadRow?.config?.provider === 'ustc' && leadRow?.config?.model === 'deepseek-flash',
    JSON.stringify(leadRow?.config ?? null))

  const sA = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '隔离会话 A' }, token, 60_000)
  const sB = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '隔离会话 B' }, token, 60_000)
  const sidA = sA.data?.sessionId
  const sidB = sB.data?.sessionId
  ok('O6', '同 Channel 创建两个会话（克隆成员）', sA.status === 200 && sB.status === 200 && Boolean(sidA && sidB),
    `A=${sidA} B=${sidB}`)
  if (!sidA || !sidB) throw new Error('session create failed')

  const sessList = await api('GET', `/api/workshop/channels/${channelId}/sessions`, undefined, token)
  const rowA = (sessList.data ?? []).find(s => s.id === sidA)
  const rowB = (sessList.data ?? []).find(s => s.id === sidB)
  const clonesA = Object.values(rowA?.memberMap ?? {})
  const clonesB = Object.values(rowB?.memberMap ?? {})
  ok('O7', '会话成员克隆互不相同（base→clone 映射隔离）',
    clonesA.length > 0 && clonesB.length > 0 && clonesA.every(x => !clonesB.includes(x)),
    `A=${clonesA.map(x => String(x).slice(0, 6)).join(',')} B=${clonesB.map(x => String(x).slice(0, 6)).join(',')}`)
  facts.sessions = { A: { id: sidA, clones: clonesA }, B: { id: sidB, clones: clonesB } }

  const TOKEN_A = `ALPHA-${STAMP.slice(-4)}`
  const TOKEN_B = `BETA-${STAMP.slice(-4)}`
  // 串行投递：ustc/deepseek-flash 单回合 ~40-90s（reasoning），并发 omp 进程会互相拖慢。
  // 会话历史的 role 对"人类消息/agent 回执"都是 ROLE_AGENT（A2A 角色，不是发送者身份），
  // 因此回执判定用正文形状：含 token 且不是我们发出的指令句（指令句含"这是会话"）。
  const isReply = (m, tokenText) => {
    const text = String(m.text ?? '')
    return text.includes(tokenText) && !text.includes('这是会话')
  }
  const sendSession = (sid, text, tag) => api('POST', `/api/workshop/channels/${channelId}/sessions/${sid}/messages`, {
    text, clientMessageId: `${tag}-${Date.now()}`,
  }, token, 60_000)
  const waitReply = (sid, tokenText, label) => waitFor(async () => {
    const r = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sid}/history?limit=100`, undefined, token)
    const hit = (r.data ?? []).find(m => isReply(m, tokenText))
    return hit ? String(hit.text) : null
  }, { timeout: 300_000, interval: 5000, label }).catch(() => null)

  const msgA = await sendSession(sidA, `这是会话 A 的隔离测试。只用一句话回复：${TOKEN_A} 已收到。不要提到任何其他会话。`, 'iso-a')
  ok('O8a', '会话 A 消息投递（clone lead）', msgA.status === 200, `status=${msgA.status}`)
  const repliesA = await waitReply(sidA, TOKEN_A, 'session A reply')
  ok('O8b', '会话 A 收到 omp 真实 LLM 回执', Boolean(repliesA), repliesA ? String(repliesA).slice(0, 160) : 'timeout')

  const msgB = await sendSession(sidB, `这是会话 B 的隔离测试。只用一句话回复：${TOKEN_B} 已收到。不要提到任何其他会话。`, 'iso-b')
  ok('O8c', '会话 B 消息投递（clone lead）', msgB.status === 200, `status=${msgB.status}`)
  const repliesB = await waitReply(sidB, TOKEN_B, 'session B reply')
  ok('O8d', '会话 B 收到 omp 真实 LLM 回执', Boolean(repliesB), repliesB ? String(repliesB).slice(0, 160) : 'timeout')

  const histA = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sidA}/history?limit=100`, undefined, token)
  const histB = await api('GET', `/api/workshop/channels/${channelId}/sessions/${sidB}/history?limit=100`, undefined, token)
  const textA = JSON.stringify(histA.data ?? [])
  const textB = JSON.stringify(histB.data ?? [])
  const aHasA = Boolean(repliesA)
  const aHasB = textA.includes(TOKEN_B)
  const bHasA = textB.includes(TOKEN_A)
  const bHasB = Boolean(repliesB)
  ok('O9', '会话 A 的完整历史只含 A（无 B 串扰）', aHasA && !aHasB, `replyA=${aHasA} leakB=${aHasB}`)
  ok('O10', '会话 B 的完整历史只含 B（无 A 串扰）', bHasB && !bHasA, `replyB=${bHasB} leakA=${bHasA}`)
  ok('O11', 'omp 真实 LLM 回执双会话到达', aHasA && bHasB, `A=${String(repliesA).slice(0, 40)} B=${String(repliesB).slice(0, 40)}`)
  facts.sessionIsolation = { aHasA, aHasB, bHasA, bHasB, replyA: repliesA, replyB: repliesB }

  // 释放会话克隆进程（避免与后续 project 任务实例的 omp 进程争用同一 provider）
  const closeA = await api('POST', `/api/workshop/channels/${channelId}/sessions/${sidA}/close`, { reason: 'isolation test done' }, token)
  const closeB = await api('POST', `/api/workshop/channels/${channelId}/sessions/${sidB}/close`, { reason: 'isolation test done' }, token)
  ok('O11b', '隔离测试后关闭两会话（释放 clone runtime）', closeA.status === 200 && closeB.status === 200,
    `A=${closeA.status} B=${closeB.status}`)

  // ── B. Project：omp leader + 两个工作项 → 各自任务实例 ──
  const proj = await api('POST', '/api/workshop/projects', {
    name: `omp项目-${STAMP.slice(-5)}`,
    objective: '验证 omp/deepseek-flash 在 Project 内核下的真实派发、隔离与验收闭环',
    description: '两个工作项并行派发到独立任务实例；LLM 产出真实 artifact。',
    leaderHarness: 'omp',
    leaderConfig: { provider: 'ustc', model: 'deepseek-flash' },
    routingPolicy: 'legacy',
    autoDispatch: false,
  }, token, 60_000)
  const pid = proj.data?.id
  ok('O12', '创建 Project（Leader=omp/deepseek-flash）', proj.status === 200 && Boolean(pid), `project=${pid} ${proj.message}`)
  if (!pid) throw new Error(`project create failed: ${proj.message}`)
  facts.project = { id: pid, leaderAgentId: proj.data?.leadAgentId }

  const bind = await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId, charter: 'omp 真实执行频道' }, token)
  ok('O13', 'Channel 绑定到 Project', bind.status === 200, `status=${bind.status} ${bind.message}`)

  const d1 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, {
    name: '隔离交付物 A', ownerChannelId: channelId, acceptanceCriteria: ['artifact 含 PROJECT-W1-OK'],
  }, token)
  const d2 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, {
    name: '隔离交付物 B', ownerChannelId: channelId, acceptanceCriteria: ['artifact 含 PROJECT-W2-OK'],
  }, token)
  ok('O14', '创建两个交付物', d1.status === 200 && d2.status === 200, `A=${d1.status} B=${d2.status}`)

  const w1 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: d1.data.id, channelId, title: 'omp 工作项 A', brief: '隔离测试 A：完成后交付 artifact，文本必须包含 PROJECT-W1-OK。只做这一件事。',
    execBudgetMinutes: 10, dedupeKey: `omp-w1-${STAMP}`,
  }, token)
  const w2 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: d2.data.id, channelId, title: 'omp 工作项 B', brief: '隔离测试 B：完成后交付 artifact，文本必须包含 PROJECT-W2-OK。只做这一件事。',
    execBudgetMinutes: 10, dedupeKey: `omp-w2-${STAMP}`,
  }, token)
  ok('O15', '创建两个工作项', w1.status === 200 && w2.status === 200, `A=${w1.status} B=${w2.status}`)
  const w1id = w1.data?.id
  const w2id = w2.data?.id

  // 手工创建的项目是 draft：派发前必须 owner 激活（绑定≥1 频道 + 必选交付物）
  const act = await api('POST', `/api/workshop/projects/${pid}/activate`, {}, token)
  ok('O15b', '项目激活（draft→active）', act.status === 200 && act.data?.status === 'active',
    `status=${act.status} project=${act.data?.status} ${act.message}`)

  // 计划门：POST /projects 默认 planApprovalRequired=1，派发前必须有 approved plan v1。
  // 走真实审批面（request-approval → owner 批准 → planVersion=1），不是绕过。
  // 计划体只放事实说明：带 deliverables/work_items 会被 plan alignment 落库成**重复工作项**
  // （实机踩坑：手动建的 2 项 + 计划对齐物化的 2 项 = 4 项）。
  const planReq = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, {
    version: 1,
    plan: { source: 'omp-live-e2e', facts: ['两个隔离工作项由 owner 手工创建并校验'] },
  }, token)
  const planAp = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)
    return (r.data ?? []).find(a => a.kind === 'plan_approval' && a.status === 'pending') ?? null
  }, { timeout: 30_000, interval: 1500, label: 'plan approval' }).catch(() => null)
  if (planAp) await api('POST', `/api/workshop/projects/${pid}/approvals/${planAp.id}/decide`, { approve: true, reason: 'owner 批准计划 v1' }, token)
  const planOk = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}`, undefined, token)
    return (r.data?.planVersion ?? 0) >= 1 ? r.data : null
  }, { timeout: 30_000, interval: 1500, label: 'plan v1 approved' }).catch(() => null)
  ok('O15c', '计划门：request→approve→planVersion=1', planReq.status === 200 && Boolean(planAp) && planOk?.planVersion >= 1,
    `request=${planReq.status} approval=${Boolean(planAp)} version=${planOk?.planVersion}`)

  // 串行派发：ustc/deepseek-flash 单回合 40-90s，两个 omp 实例并发会互相拖慢到超预算。
  // 串行更能证明"每个工作项独立任务实例"，且给每个 LLM 回合完整预算。
  const dispA = await api('POST', `/api/workshop/projects/${pid}/work-items/${w1id}/dispatch`, {}, token, 60_000)
  ok('O16a', '工作项 A 派发（独立任务实例）', dispA.status === 200, `status=${dispA.status} ${dispA.message}`)
  const chainA = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${w1id}`, undefined, token)
  const instA = chainA.data?.attempts?.[0]?.channelId
  const taskA = chainA.data?.attempts?.[0]?.channelTaskId
  const completedA = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, token)
    const wi = (r.data ?? []).find(x => x.id === w1id)
    return wi?.state === 'COMPLETED' ? true : null
  }, { timeout: 600_000, interval: 5000, label: 'work item A completed' }).catch(() => false)
  ok('O18', 'omp 真实执行：工作项 A 完成', completedA === true, String(completedA))

  // 交付后立即对账：生成 A 的成果 draft，并释放 A 的任务实例（停用/卸载 runtime），
  // 保证 B 派发时只有 B 一个 omp 进程占用 provider。
  if (completedA) {
    await api('POST', `/api/workshop/projects/${pid}/reconcile`, {}, token)
    await sleep(3000)
  }

  const dispB = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2id}/dispatch`, {}, token, 60_000)
  ok('O16b', '工作项 B 派发（独立任务实例）', dispB.status === 200, `status=${dispB.status} ${dispB.message}`)
  const chainB = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${w2id}`, undefined, token)
  const instB = chainB.data?.attempts?.[0]?.channelId
  const taskB = chainB.data?.attempts?.[0]?.channelTaskId
  const completedB = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, token)
    const wi = (r.data ?? []).find(x => x.id === w2id)
    return wi?.state === 'COMPLETED' ? true : null
  }, { timeout: 600_000, interval: 5000, label: 'work item B completed' }).catch(() => false)
  ok('O19', 'omp 真实执行：工作项 B 完成', completedB === true, String(completedB))

  ok('O17', '任务实例隔离：两个工作项 → 不同 Channel/task', Boolean(instA && instB && instA !== instB && taskA !== taskB),
    `instA=${instA?.slice(0, 8)} instB=${instB?.slice(0, 8)}`)
  facts.instances = { A: { channelId: instA, taskId: taskA }, B: { channelId: instB, taskId: taskB } }

  // 任务实例维度会话隔离：每个实例 channel 的 session 不同，且 artifact 只含自己的 token
  const sessOfInstance = async (instanceChannelId) => {
    const r = await api('GET', `/api/workshop/channels/${instanceChannelId}/sessions`, undefined, token)
    return (r.data ?? []).map(s => s.id)
  }
  const instSessionsA = instA ? await sessOfInstance(instA) : []
  const instSessionsB = instB ? await sessOfInstance(instB) : []
  ok('O20', '任务实例会话隔离（实例 A/B 的 session 集合无交集）',
    instSessionsA.length > 0 && instSessionsB.length > 0 && instSessionsA.every(x => !instSessionsB.includes(x)),
    `A=${instSessionsA.map(x => String(x).slice(0, 6)).join(',')} B=${instSessionsB.map(x => String(x).slice(0, 6)).join(',')}`)

  const artifactText = async (workItemId) => {
    const c = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${workItemId}`, undefined, token)
    return JSON.stringify(c.data?.attempts ?? [])
  }
  const artA = await artifactText(w1id)
  const artB = await artifactText(w2id)
  ok('O21', 'artifact 无跨任务污染（A 只含 W1，B 只含 W2）',
    artA.includes('PROJECT-W1-OK') && !artA.includes('PROJECT-W2-OK') && artB.includes('PROJECT-W2-OK') && !artB.includes('PROJECT-W1-OK'),
    `A=${artA.includes('PROJECT-W1-OK')}/${artA.includes('PROJECT-W2-OK')} B=${artB.includes('PROJECT-W2-OK')}/${artB.includes('PROJECT-W1-OK')}`)

  // ── D. 对账 → 成果 → 提交 → L1 → 验收 → L2 → completed ──
  await api('POST', `/api/workshop/projects/${pid}/reconcile`, {}, token)
  const drafts = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/results`, undefined, token)
    const rows = r.data ?? []
    const a = rows.find(x => x.workItemId === w1id)
    const b = rows.find(x => x.workItemId === w2id)
    return a && b ? { a, b } : null
  }, { timeout: 120_000, interval: 3000, label: 'result drafts' }).catch(() => null)
  ok('O22', '对账生成两份成果 draft（各绑定自己的 root artifact）', Boolean(drafts?.a && drafts?.b),
    `A=${drafts?.a?.status} B=${drafts?.b?.status}`)

  for (const [label, r] of [['A', drafts?.a], ['B', drafts?.b]]) {
    if (!r) continue
    const sub = await api('POST', `/api/workshop/projects/${pid}/results/${r.id}/submit`, {
      summary: `omp 真实交付 ${label}：artifact 已由 LLM 产出并绑定本任务。`,
    }, token)
    const rv = await api('POST', `/api/workshop/projects/${pid}/results/${r.id}/review`, {
      decision: 'reviewed', reason: '独立 L1 复核：artifact 与验收标准一致',
    }, reviewerToken)
    ok(`O23${label}`, `成果 ${label} 提交 + L1 复核`, sub.status === 200 && rv.status === 200, `submit=${sub.status} review=${rv.status}`)
  }

  for (const r of [drafts?.a, drafts?.b]) {
    if (!r) continue
    await api('POST', `/api/workshop/projects/${pid}/results/${r.id}/request-acceptance`, {}, token)
  }
  const pend = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)
    const rows = (r.data ?? []).filter(a => a.status === 'pending' && a.kind === 'deliverable_acceptance')
    return rows.length >= 2 ? rows : null
  }, { timeout: 60_000, interval: 2000, label: 'acceptance approvals' }).catch(() => [])
  for (const ap of pend) {
    await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true, reason: 'L2 业务签核' }, reviewerToken)
  }
  const approved = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/deliverables`, undefined, token)
    const rows = r.data ?? []
    return rows.length >= 2 && rows.every(d => ['approved', 'waived'].includes(d.status))
  }, { timeout: 60_000, interval: 2000, label: 'deliverables approved' }).catch(() => false)
  ok('O24', 'L2 签核 → 两份交付物 approved', approved === true && pend.length >= 2, `approvals=${pend.length}`)

  const done = await api('POST', `/api/workshop/projects/${pid}/complete`, { reason: 'omp 实机验收完成' }, token)
  const completeAp = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, token)
    return (r.data ?? []).find(a => a.kind === 'project_complete' && a.status === 'pending') ?? null
  }, { timeout: 60_000, interval: 2000, label: 'project complete approval' }).catch(() => null)
  if (completeAp) await api('POST', `/api/workshop/projects/${pid}/approvals/${completeAp.id}/decide`, { approve: true, reason: '完成门确认' }, reviewerToken)
  const final = await waitFor(async () => {
    const r = await api('GET', `/api/workshop/projects/${pid}`, undefined, token)
    return r.data?.status === 'completed' ? r.data : null
  }, { timeout: 60_000, interval: 2000, label: 'project completed' }).catch(() => null)
  ok('O25', 'Project completed（omp 全链闭环）', final?.status === 'completed', `status=${final?.status} complete=${done.status}`)
  facts.final = { status: final?.status, planVersion: final?.planVersion }

  const obs = await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, token)
  ok('O26', 'observability：两工作项 accepted + 两交付物签核',
    (obs.data?.workItems ?? []).every(w => w.stage === 'accepted') && (obs.data?.summary?.acceptanceProgress === 1),
    `stages=${(obs.data?.workItems ?? []).map(w => w.stage).join(',')} acceptance=${obs.data?.summary?.acceptanceProgress}`)

  // ── E. 真实浏览器：入口 → 项目 → 看板/会话 ──
  const ui = await runUi(token, pid)
  results.push(...ui.results)

  const fail = results.filter(r => !r.pass).length
  const summary = { generatedAt: new Date().toISOString(), base: BASE, home: HOME, verdict: fail === 0 ? 'PASS' : 'FAIL', pass: results.length - fail, fail, facts, results, ui: ui.meta }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(summary, null, 2))
  const md = [
    `# omp(ustc/deepseek-flash) Channel·Project·Session 实机验收 · ${summary.verdict}`,
    '',
    `- 时间：${summary.generatedAt}`,
    `- 实例：${BASE}（隔离 AW_HOME=${HOME}）`,
    `- Harness：omp @ ustc/deepseek-flash`,
    `- Project：${pid} · Channel：${channelId}`,
    `- 结果：${summary.pass}/${results.length} 通过`,
    '',
    '| # | 断言 | 结果 | 证据 |',
    '| --- | --- | --- | --- |',
    ...results.map(r => `| ${r.id} | ${r.name} | ${r.pass ? '✔' : '✖'} | ${String(r.detail).replace(/\|/g, '/').slice(0, 180)} |`),
    '',
    `截图：${OUT}`,
  ].join('\n')
  writeFileSync(join(OUT, 'report.md'), md)
  console.log(`\n=== OMP LIVE ${summary.verdict} pass=${summary.pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}
catch (err) {
  console.error('OMP E2E 异常:', err?.stack ?? err)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), verdict: 'FAIL', error: errMsg(err), results, facts }, null, 2))
  process.exitCode = 1
}
finally {
  try { await Promise.race([browser?.close(), sleep(3000)]) } catch { /* ignore */ }
  try { child?.kill() } catch { /* ignore */ }
  if (!KEEP) {
    try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  await sleep(400)
  process.exit(process.exitCode ?? 0)
}

/* ── 浏览器：项目中心 / 详情 / 看板 / 会话 ─────────────────────────────── */

async function runUi(token, pid) {
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const uiResults = []
  const errors = []
  const meta = { screenshots: [] }
  const push = (id, name, cond, detail = '') => {
    const pass = Boolean(cond)
    uiResults.push({ id, name, pass, detail: String(detail).slice(0, 500) })
    console.log(`${pass ? '✔' : '✖'} [${id}] ${name}${pass ? '' : ` — ${String(detail).slice(0, 300)}`}`)
  }
  try {
    browser = await launch({ width: 1440, height: 900 })
    const page = await openPage(browser, { token, width: 1440, height: 900, dark: false })
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))

    await gotoReady(page, '/projects', { wait: 2200 })
    const listText = await page.evaluate(() => document.body.innerText)
    push('U1', '项目中心入口与列表渲染', listText.includes('项目中心') && listText.includes('omp项目') && listText.includes('新建项目'), listText.slice(0, 160))
    await page.screenshot({ path: join(OUT, 'ui-projects-list.png'), fullPage: true })
    meta.screenshots.push('ui-projects-list.png')

    await gotoReady(page, `/projects/${pid}`, { wait: 2400 })
    const ov = await page.evaluate(() => document.body.innerText)
    push('U2', '详情概览：双交付物/omp 频道/100% 进度',
      ov.includes('omp真实频道') && ov.includes('隔离交付物 A') && ov.includes('100%'), ov.slice(0, 200))
    await page.screenshot({ path: join(OUT, 'ui-project-overview.png'), fullPage: true })
    meta.screenshots.push('ui-project-overview.png')

    await page.evaluate(() => document.querySelector('[data-testid="tab-plan"]')?.click())
    await sleep(1200)
    const plan = await page.evaluate(() => document.body.innerText)
    push('U3', '计划页：两工作项终态 + 看板', plan.includes('omp 工作项 A') && plan.includes('omp 工作项 B') && plan.includes('已验收'), plan.slice(0, 220))
    await page.screenshot({ path: join(OUT, 'ui-project-plan.png'), fullPage: true })
    meta.screenshots.push('ui-project-plan.png')

    push('U4', '页面无未捕获异常', errors.length === 0, errors.join('; '))
    meta.url = page.url()
    meta.errors = errors
  }
  catch (e) {
    push('U-err', '浏览器验收异常', false, e?.stack ?? String(e))
    meta.errors = errors
  }
  return { results: uiResults, meta }
}
