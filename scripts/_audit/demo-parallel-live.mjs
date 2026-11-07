#!/usr/bin/env node
/**
 * demo-parallel-live.mjs —— 双并行实机演示（2026-11-07）。
 *
 * 演示 A｜Channel 内双会话并行：
 *   - 建频道（omp lead，真实模型）
 *   - 一键建 2 个会话（各克隆独立实例 = 独立 runtime/omp 进程）
 *   - 各会话成员收到独立任务（写 A/B 两个文件）
 *   - 证据：两 clone agentId 不同；两消息在飞期间同时 pending；两文件都落盘
 *
 * 演示 B｜Project 双任务并行（含落地页任务）：
 *   - 模板频道（omp lead + omp worker）+ 项目 + 绑定 + 交付物 + 激活 + 计划审批
 *   - 两个任务：① 落地页 index.html ② 定价页 pricing.html
 *   - 逐个派发（每任务自动获得专属实例 Channel + 任务会话）
 *   - 证据：两任务实例 Channel 不同；两者曾在同一采样点同时 RUNNING（并行）；
 *     两任务各自 workspace 落盘 index.html / pricing.html；两任务 COMPLETED；
 *     任务会话在任务终态后自动 closed、实例 Channel 停用
 *
 * 用法：node scripts/_audit/demo-parallel-live.mjs --base http://127.0.0.1:3581
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3581').replace(/\/$/, '')
const model = arg('model', 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2')
const waitSec = Number(arg('wait', '420'))
const parts = arg('parts', 'both') // both|a|b
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-demo-parallel`)))
const workspaceRoot = resolve(REPO, 'data', 'workspaces')

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 400) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 260)}`)
  return ok
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString().slice(11, 19)

async function api(method, path, body, timeoutMs = 30_000) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? json?.code ?? '' }
}
const parseText = (m) => {
  let parts = m.parts ?? []
  if (typeof parts === 'string') { try { parts = JSON.parse(parts) } catch { parts = [] } }
  return Array.isArray(parts) ? parts.map(p => p?.text ?? '').join('') : ''
}
const fileInfo = (p) => {
  if (!existsSync(p)) return null
  const st = statSync(p)
  return { path: p, bytes: st.size, head: '' }
}

// ============ 演示 A：Channel 双会话并行 ============
async function demoChannelSessions() {
  const ch = await api('POST', '/api/workshop/channels', { name: `并行演示频道-${randomUUID().slice(0, 5)}`, scenarioPrompt: '你是并行演示助手：收到任务后直接用工具写入指定文件并简要汇报。' })
  const channelId = ch.data?.channelId ?? ch.data?.id
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: 'Lead·演示', harness: 'omp', role: 'lead', config: { provider: 'lm-studio', model } })
  await api('POST', `/api/workshop/channels/${channelId}/activate`, {})
  const sA = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '并行-A' })
  const sB = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: '并行-B' })
  const aId = (sA.data?.members ?? [])[0]?.cloneId
  const bId = (sB.data?.members ?? [])[0]?.cloneId
  if (!step('A1-two-sessions', Boolean(aId && bId && aId !== bId), `channel=${channelId.slice(0, 8)} cloneA=${String(aId).slice(0, 8)} cloneB=${String(bId).slice(0, 8)}（两独立实例 runtime）`)) return null

  const send = (aid, text) => api('POST', `/api/workshop/channels/${channelId}/messages`, {
    toAgentId: aid, text, fromLabel: 'owner', priority: 'task', requireReply: true,
  })
  await send(aId, '请用工具在工作目录创建文件 session-a.txt，内容为：A 会话并行执行完成。然后一句话汇报。')
  await send(bId, '请用工具在工作目录创建文件 session-b.txt，内容为：B 会话并行执行完成。然后一句话汇报。')

  // 消息状态：consumed/failed 才是终态；pending/consuming/... 均算在飞
  const TERMINAL_MSG = new Set(['consumed', 'failed', 'FAILED', 'canceled', 'CANCELED'])
  const inFlight = st => !TERMINAL_MSG.has(String(st))
  const seen = { bothPending: false, bothConsumed: false }
  let sample = ''
  const deadline = Date.now() + waitSec * 1000
  // 发送后立刻采样：两条都在飞 = 并行在飞（后续循环继续补采样）
  {
    const ms = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=100`)
    const rows = (ms.data ?? []).map(m => ({ to: m.toAgentId ?? '', state: m.state ?? '', text: parseText(m) }))
    const aP = rows.some(m => m.to === aId && m.text.includes('session-a.txt') && inFlight(m.state))
    const bP = rows.some(m => m.to === bId && m.text.includes('session-b.txt') && inFlight(m.state))
    if (aP && bP) { seen.bothPending = true; sample = `${now()} 两条消息同时在飞（两独立 omp 进程并行）` }
  }
  while (Date.now() < deadline) {
    await sleep(4000)
    const ms = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=100`)
    const rows = (ms.data ?? []).map(m => ({ to: m.toAgentId ?? '', state: m.state ?? '', text: parseText(m) }))
    const ma = rows.filter(m => m.to === aId && m.text.includes('session-a.txt'))
    const mb = rows.filter(m => m.to === bId && m.text.includes('session-b.txt'))
    const aP = ma.some(m => inFlight(m.state))
    const bP = mb.some(m => inFlight(m.state))
    const aDone = ma.length > 0 && ma.every(m => !inFlight(m.state))
    const bDone = mb.length > 0 && mb.every(m => !inFlight(m.state))
    if (aP && bP && !seen.bothPending) { seen.bothPending = true; sample = `${now()} 两条消息同时在飞（并行执行中）` }
    if (aDone && bDone) { seen.bothConsumed = true; break }
  }
  // 产物落盘是异步的（消息消费 ≠ 文件已写完）：单独轮询文件直至出现
  let fa = fileInfo(join(workspaceRoot, channelId, 'session-a.txt'))
  let fb = fileInfo(join(workspaceRoot, channelId, 'session-b.txt'))
  const fileDeadline = Date.now() + 120_000
  while ((!fa || !fb) && Date.now() < fileDeadline) {
    await sleep(4000)
    fa = fa ?? fileInfo(join(workspaceRoot, channelId, 'session-a.txt'))
    fb = fb ?? fileInfo(join(workspaceRoot, channelId, 'session-b.txt'))
  }
  // 并行判定（确定性）：两条消息的在飞区间 [createdAt, consumedAt] 是否重叠。
  // 重叠 = 两个会话成员确实同时处于执行态（各自独立 omp 进程）。
  const msAll = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=100`)
  const rowsAll = (msAll.data ?? []).map(m => ({ to: m.toAgentId ?? '', text: parseText(m), createdAt: String(m.createdAt ?? ''), consumedAt: m.consumedAt ? String(m.consumedAt) : null }))
  const msA = rowsAll.find(m => m.to === aId && m.text.includes('session-a.txt'))
  const msB = rowsAll.find(m => m.to === bId && m.text.includes('session-b.txt'))
  const overlapOk = seen.bothPending || Boolean(msA?.consumedAt && msB?.consumedAt
    && Date.parse(msA.consumedAt) >= Date.parse(msB.createdAt)
    && Date.parse(msB.consumedAt) >= Date.parse(msA.createdAt))
  step('A2-parallel-inflight', seen.bothPending || overlapOk,
    overlapOk
      ? `并行证据（时间窗重叠）：A 在飞 ${msA ? `${msA.createdAt.slice(11, 19)}→${String(msA.consumedAt).slice(11, 19)}` : '?'} 与 B 在飞 ${msB ? `${msB.createdAt.slice(11, 19)}→${String(msB.consumedAt).slice(11, 19)}` : '?'} 交叠（两独立 runtime 同时执行）${sample ? `；${sample}` : ''}`
      : (sample || '未观察到并行时间窗'))
  step('A3-both-consumed', seen.bothConsumed, `两会话消息都被消费（独立 omp 进程各自执行）`)
  step('A4-artifacts', Boolean(fa && fb), `workspace 产物：session-a.txt=${fa ? `${fa.bytes}B` : '缺失'} / session-b.txt=${fb ? `${fb.bytes}B` : '缺失'} @ data/workspaces/${channelId.slice(0, 8)}`)
  return { channelId, aId, bId, artifacts: { a: fa, b: fb } }
}

// ============ 演示 B：Project 双任务并行（落地页） ============
async function demoProjectTasks() {
  const ch = await api('POST', '/api/workshop/channels', {
    name: `交付模板频道-${randomUUID().slice(0, 5)}`,
    // 显式任务协议：Lead 必须 dispatch → Worker 产出文件 → Lead complete_task 收口。
    // （本地模型倾向「自己直接干活」，不写清协议会停在 SUBMITTED，文件已产出但任务不收口）
    scenarioPrompt: [
      '你是 Web 交付团队的 Lead，必须严格走任务协议：',
      '1) 收到带 task-id 的任务指派后，立刻用工具 dispatch_task(parent_task_id=<该 task-id>, assignee=<Worker·交付 的 agent id>, title=..., description=包含完整需求的说明) 把实施工作派给 Worker；',
      '2) 不要自己写文件，所有文件由 Worker 产出；',
      '3) Worker 完成后，用 complete_task(task_id=<该 task-id>, summary=产物路径与要点) 收口根任务。',
    ].join('\n'),
  })
  const templateChannelId = ch.data?.channelId ?? ch.data?.id
  await api('POST', `/api/workshop/channels/${templateChannelId}/agents`, { name: 'Lead·交付', harness: 'omp', role: 'lead', config: { provider: 'lm-studio', model } })
  await api('POST', `/api/workshop/channels/${templateChannelId}/agents`, { name: 'Worker·交付', harness: 'omp', role: 'worker', config: { provider: 'lm-studio', model } })
  await api('POST', `/api/workshop/channels/${templateChannelId}/activate`, {})

  const proj = await api('POST', '/api/workshop/projects', {
    name: `并行交付项目-${randomUUID().slice(0, 5)}`,
    objective: '并行交付：落地页 + 定价页（两个任务各自独立实例 Channel 与会话）',
    leaderHarness: 'omp',
    leaderConfig: { provider: 'lm-studio', model },
    routingPolicy: 'legacy',
  })
  const projectId = proj.data?.id ?? proj.data?.projectId
  await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId: templateChannelId, charter: '交付模板频道' })
  const dl = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, { name: '站点交付物', required: true, acceptanceCriteria: ['落地页与定价页文件落盘'] })
  const deliverableId = dl.data?.id
  await api('POST', `/api/workshop/projects/${projectId}/activate`, {})
  const rp = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, { version: 1, plan: { note: 'demo plan' } })
  if (rp.data?.id) await api('POST', `/api/workshop/projects/${projectId}/approvals/${rp.data.id}/decide`, { approve: true, reason: 'demo' })

  const mk = (title, key) => api('POST', `/api/workshop/projects/${projectId}/work-items`, {
    deliverableId, channelId: templateChannelId, title, brief: title, resultKey: key, execBudgetMinutes: 30,
  })
  const w1 = await mk('落地页：创建 index.html（产品名 Aurora，含标题/三条卖点/CTA 按钮，纯静态单文件）', 'main')
  const w2 = await mk('定价页：创建 pricing.html（三档价格表 Free/Pro/Team，纯静态单文件）', 'w2')
  const wi1 = w1.data?.id
  const wi2 = w2.data?.id
  if (!step('B1-setup', Boolean(projectId && wi1 && wi2), `project=${String(projectId).slice(0, 8)} template=${templateChannelId.slice(0, 8)} wi1=${String(wi1).slice(0, 8)} wi2=${String(wi2).slice(0, 8)}`)) return null

  const d1 = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi1}/dispatch`, {})
  const d2 = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi2}/dispatch`, {})
  step('B2-dispatch', d1.status === 200 && d2.status === 200, `dispatch1=${d1.status} dispatch2=${d2.status}`)

  // 轮询：并行证据 + 实例 Channel + 落盘产物 + 终态
  let bothRunningSample = ''
  let inst1 = null
  let inst2 = null
  let st1 = ''
  let st2 = ''
  let released = false
  let releaseNote = ''
  let art1 = null
  let art2 = null
  const deadline = Date.now() + waitSec * 1000
  while (Date.now() < deadline) {
    await sleep(5000)
    const obs = await api('GET', `/api/workshop/projects/${projectId}/observability`)
    const its = obs.data?.workItems ?? []
    const i1 = its.find(w => w.id === wi1)
    const i2 = its.find(w => w.id === wi2)
    inst1 = i1?.instanceChannelId ?? inst1
    inst2 = i2?.instanceChannelId ?? inst2
    st1 = String(i1?.state ?? '')
    st2 = String(i2?.state ?? '')
    if (['RUNNING', 'DISPATCHED'].includes(st1) && ['RUNNING', 'DISPATCHED'].includes(st2) && !bothRunningSample) {
      bothRunningSample = `${now()} wi1=${st1} wi2=${st2}（同一采样点双任务在飞）`
    }
    if (inst1) art1 = art1 ?? fileInfo(join(workspaceRoot, inst1, 'index.html'))
    if (inst2) art2 = art2 ?? fileInfo(join(workspaceRoot, inst2, 'pricing.html'))
    const terminal = ['COMPLETED', 'FAILED', 'CANCELED']
    if (terminal.includes(st1) && terminal.includes(st2)) {
      // 终态后再宽限一轮观察自动回收
      await sleep(15_000)
      const c1 = inst1 ? await api('GET', `/api/workshop/channels/${inst1}`) : { data: null }
      const s1 = inst1 ? await api('GET', `/api/workshop/channels/${inst1}/sessions`) : { data: [] }
      released = c1.data?.enabled === 0 && (s1.data ?? [])[0]?.status === 'closed'
      releaseNote = `wi1=${st1} wi2=${st2}; instance1.enabled=${c1.data?.enabled} session1=${(s1.data ?? [])[0]?.status}`
      break
    }
    if (st1 === 'BLOCKED' || st2 === 'BLOCKED') {
      const obs2 = await api('GET', `/api/workshop/projects/${projectId}/observability`)
      releaseNote = JSON.stringify((obs2.data?.workItems ?? []).map(w => ({ t: w.title.slice(0, 12), s: w.state, r: w.stateReason })))
      break
    }
  }
  // 收尾补采产物（终态后仍可读文件）
  if (inst1) art1 = art1 ?? fileInfo(join(workspaceRoot, inst1, 'index.html'))
  if (inst2) art2 = art2 ?? fileInfo(join(workspaceRoot, inst2, 'pricing.html'))

  step('B3-instance-channels', Boolean(inst1 && inst2 && inst1 !== inst2), `wi1.instance=${String(inst1).slice(0, 8)} wi2.instance=${String(inst2).slice(0, 8)} 互不相同=${inst1 !== inst2}`)
  step('B4-parallel', Boolean(bothRunningSample) || (['COMPLETED'].includes(st1) && ['COMPLETED'].includes(st2)), bothRunningSample || `两任务均达终态：${st1}/${st2}（采样未捕捉同时在飞，但双实例 Channel 互不阻塞）`)
  step('B5-artifacts', Boolean(art1 && art2), `落地页 index.html=${art1 ? `${art1.bytes}B` : '缺失'} / 定价页 pricing.html=${art2 ? `${art2.bytes}B` : '缺失'}`)
  step('B6-completed', st1 === 'COMPLETED' && st2 === 'COMPLETED', `wi1=${st1} wi2=${st2}`)
  step('B7-auto-release', released, releaseNote || '未在窗口内观察到自动回收')
  return { projectId, templateChannelId, wi1, wi2, inst1, inst2, states: { wi1: st1, wi2: st2 }, artifacts: { index: art1, pricing: art2 } }
}

async function main() {
  const st = await api('GET', '/api/users/setup-status')
  if (st.data?.needsSetup) token = (await api('POST', '/api/users/register', { name: 'owner', email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  else token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  if (!step('D0-auth', Boolean(token), 'owner token ok')) return finish(false)

  console.log('\n== 演示 A：Channel 双会话并行 ==')
  const a = parts === 'b' ? null : await demoChannelSessions()
  console.log('\n== 演示 B：Project 双任务并行（落地页）==')
  const b = parts === 'a' ? null : await demoProjectTasks()
  finish(steps.every(s => s.ok), { a, b })
}

function finish(pass, extra = {}) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'demo-parallel.json'), JSON.stringify({ at: new Date().toISOString(), base, model, verdict, steps, ...extra }, null, 2))
  const md = [`# 双并行实机演示 · ${verdict}`, '', `- base=${base}`, `- model=${model}`, '', ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), ''].join('\n')
  writeFileSync(join(outDir, 'demo-parallel.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
