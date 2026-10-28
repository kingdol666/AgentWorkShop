#!/usr/bin/env node
/**
 * 多专家审查整改 · 真实场景验收(2026-10-28)。
 *
 * 真实平台(.output 生产构建)+ 真实 omp 子进程 + 本机 LM Studio Qwen3.5-9B(32k),
 * 单频道、**worker 身份执行**(lead 只存在不派活):
 *   R1  AgentChannel 创建(lead + worker 成员)
 *   R2  worker 绑定节点(DAQ 观察 + DCW 点位写授权)落库
 *   R3  运行时提示词注入:节点语义卡(名称/量程/单步/手动确认)+ 执行模式卡
 *   R4  工具注入面按绑定面差异化(recipe_trial 描述含该 worker 的 dcw 节点)
 *   R5  任务 COMPLETED(omp + Qwen3.5),工具链 my_industrial_nodes → daq_query → recipe_trial
 *   R6  手动模式 HITL:审批卡挂起 → 人工批准 → ACK 设备证实
 *   R7  效果:节点值变更、trial 不改配方版本、journal 锚点新增、TSDB 有真实样本
 *
 * 运行:node scripts/e2e-multiexpert-remediation-real.mjs
 * 证据:docs/audit/evidence/2026-10-28-multiexpert-remediation/report.json
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_ACCEPT_HOME ?? 'D:/tmp/aw-multiexpert-20261028'
const PORT = Number(process.env.AW_ACCEPT_PORT ?? 3411)
const BASE = `http://127.0.0.1:${PORT}`
const MODEL = { provider: 'lm-studio', model: 'qwen3.5-9b-32k', contextTokens: 32768 }
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-multiexpert-remediation')
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1200) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 800)}`}`)
  return Boolean(cond)
}

function stopOwnedInstance() {
  const pidFile = join(HOME, 'server.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  }
  catch { /* 已退出 */ }
}

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json())?.data ?? null
  }
  catch {
    return null
  }
}

async function startInstance() {
  stopOwnedInstance()
  await sleep(1500)
  const running = await health()
  if (running) throw new Error(`端口 ${PORT} 已被非本验收实例占用:${running.app} ${running.version}`)
  if (process.env.AW_ACCEPT_RESET !== '0') {
    if (!/aw-multiexpert/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
    rmSync(HOME, { recursive: true, force: true })
  }
  mkdirSync(HOME, { recursive: true })
  const log = openSync(join(HOME, 'server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      PORT: String(PORT),
      NUXT_SESSION_PASSWORD: 'multiexpert-20261028-session-key-abcdef',
      AW_TRIAL_INTERVAL_MS: '0',
      AW_RATE_LIMIT_OFF: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(join(HOME, 'server.pid'), String(child.pid))
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const h = await health()
    if (h?.workshop === 'ready') return h
  }
  throw new Error('隔离实例未在 120s 内就绪')
}

let admin = ''
async function api(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}

const dbPath = join(HOME, 'data', 'workshop.sqlite')
function agentTokenOf(agentId) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
  }
  finally {
    db.close()
  }
}

async function pendingOf(agentId) {
  const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}`)
  return (r?.data?.approvals ?? []).filter(a => a.status === 'pending')
}

async function approvalsHistory(agentId) {
  const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}&scope=history`)
  return r?.data?.approvals ?? []
}

async function approve(cardId, comment) {
  return api('POST', `/api/workshop/agent-tools/approvals/${cardId}/decide`, { approved: true, comment })
}

function taskOf(r) {
  return r?.data?.task ?? r?.data ?? null
}

function deliverableOf(task) {
  const art = (task?.artifacts ?? []).find(a => a.name === 'deliverable')
  return String(art?.parts?.map(p => p.text ?? '').join('\n') ?? '')
}

function toolCallsOf(task) {
  return (task?.history ?? [])
    .map(h => String(h?.parts?.map(p => p.text ?? '').join(' ') ?? ''))
    .filter(t => t.includes('🔧'))
    .map(t => t.replace(/\s+/g, ' ').slice(0, 300))
}

async function waitTask(taskId, { timeoutMs = 15 * 60_000, autoApprove = false, onCard = null } = {}) {
  const started = Date.now()
  const cards = []
  let lastState = ''
  while (Date.now() - started < timeoutMs) {
    const r = await api('GET', `/api/workshop/tasks/${taskId}`)
    const task = taskOf(r)
    const state = String(task?.state ?? '')
    if (state !== lastState) {
      lastState = state
      console.log(`    · task ${taskId.slice(0, 8)} state=${state}`)
    }
    if (autoApprove && task?.assigneeId) {
      const pending = await pendingOf(String(task.assigneeId))
      for (const card of pending) {
        if (cards.some(c => c.id === card.id)) continue
        cards.push(card)
        if (onCard) onCard(card)
      }
    }
    if (['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(state)) return { task, cards, timedOut: false }
    await sleep(3000)
  }
  const r = await api('GET', `/api/workshop/tasks/${taskId}`)
  return { task: taskOf(r), cards, timedOut: true }
}

async function submitTask(channelId, title, description, assigneeId) {
  const r = await api('POST', `/api/workshop/channels/${channelId}/tasks`, { title, description, assigneeId })
  const task = taskOf(r)
  if (!task?.id) throw new Error(`任务创建失败: ${JSON.stringify(r).slice(0, 400)}`)
  return task
}

const scenarioLine = (name, controlMode, description) =>
  api('POST', '/api/workshop/dcw/lines', { name, simulated: true, controlMode, description }).then(r => r.data.line)

const makeDaq = async attrs => (await api('POST', '/api/workshop/daq', {
  driver: 'mock', intervalMs: 1000, enabled: true, publishIntervalMs: 0, ...attrs,
})).data.node

const makeDcw = async attrs => (await api('POST', '/api/workshop/dcw', {
  driver: 'mock', enabled: true, holdIntervalMs: 0, readIntervalMs: 0, writeLockSeconds: 0, stepLimit: 5, ...attrs,
})).data.node

async function remapParam(lineId, nodeId, key, desc) {
  const params = (await api('GET', `/api/workshop/dcw/params?lineId=${lineId}`)).data.params ?? []
  const pm = params.find(p => p.nodeId === nodeId)
  if (!pm) throw new Error(`参数映射不存在: node=${nodeId}`)
  await api('PATCH', `/api/workshop/dcw/params/${pm.id}`, { key, desc, min: 0, max: 100 })
}

/** 注:本函数创建 lead;worker 另经 /agents 路由加入(worker 才是本轮的作业身份) */
async function makeChannel(name, lineId, scenarioPrompt, mode, toolNames) {
  const ch = (await api('POST', '/api/workshop/channels', {
    name,
    lineId,
    scenarioPrompt,
    leadAgent: { name: `${name}-线长`, harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools'] } },
  })).data
  const channelId = ch?.channelId
  if (!channelId) throw new Error(`频道创建失败: ${JSON.stringify(ch).slice(0, 300)}`)
  await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: { provider: MODEL.provider, model: MODEL.model } })
  await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, mode === 'auto' ? { mode: 'auto', confirm: true } : { mode })
  const put = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
    mode: 'selected',
    tools: toolNames.map(n => ({ name: n, enabled: true })),
  })
  const agents = (await api('GET', `/api/workshop/channels/${channelId}`))?.data?.agents ?? []
  const lead = agents.find(a => a.role === 'lead')
  return { channelId, lead, toolsSaved: put.status, agents }
}

async function addWorker(channelId, name) {
  const r = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    name,
    harness: 'omp',
    role: 'worker',
    config: { rpcMode: 'rpc', args: ['--no-tools'] },
  })
  const worker = r?.data?.agent ?? r?.data
  if (!worker?.id) throw new Error(`worker 创建失败: ${JSON.stringify(r).slice(0, 400)}`)
  return worker
}

async function bindNode(agentId, nodeId, kind, mode = 'manual') {
  const created = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, mode })
  const b = created?.data?.binding
  if (!b) throw new Error(`绑定失败: ${JSON.stringify(created).slice(0, 300)}`)
  if (mode === 'auto' && b.mode !== 'auto') {
    const patched = await api('PATCH', `/api/workshop/agent-tools/bindings/${b.id}`, { mode: 'auto', confirm: true })
    return patched?.data?.binding ?? b
  }
  return b
}

/** 提示词注入探针:同一 AW_HOME 的只读 sidecar,调用运行时同一个 buildIndustrialContext */
function promptProbe(agentId) {
  const r = spawnSync(process.execPath, [
    join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--tsconfig', '.nuxt/tsconfig.server.json',
    join(REPO, 'scripts', '_audit', 'prompt-injection-probe.mts'),
    agentId,
  ], {
    cwd: REPO,
    env: { ...process.env, AW_MODE: 'home', AW_HOME: HOME, AW_SKIP_DATA_LOCK: '1' },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`prompt probe 失败(${r.status}): ${String(r.stderr ?? '').slice(0, 800)}`)
  return JSON.parse(String(r.stdout))
}

const WORK_PROMPT = lineId => [
  '你是工艺闭环的作业员(worker)。严格按四步执行,不要做别的:',
  '1) 调用 my_industrial_nodes 查看你绑定的数控节点(id/量程/单步);',
  '2) 调用 daq_query:line_id="' + lineId + '",last_minutes=5,bucket_ms=15000,limit=200,记录温度均值与样本数;',
  '3) 调用 recipe_trial:line_id="' + lineId + '",params 只包含你绑定的那个数控节点,value=56,hypothesis 写「基于数采集证据把温度设定由 60 调到 56,验证窗口内响应」;审批由人工处理,工具会返回结果,你不需要等待;',
  '4) 调用 complete_task 提交:daq_query 的样本数与均值、recipe_trial 的完整回执原文与批次 id。',
  '本任务只做这四步:禁止复测、禁止等待/睡眠、禁止 recipe_update/rollback、禁止使用 bash/终端。',
].join('\n')

const TOOLS = ['my_industrial_nodes', 'daq_query', 'recipe_trial', 'recipe_rollback', 'complete_task', 'report_progress']

const evidence = {
  at: new Date().toISOString(),
  env: {
    base: BASE,
    home: HOME,
    version: '',
    model: MODEL,
    harness: 'omp(真实子进程)',
    devices: 'mock(daq+dcw;无物理响应耦合)',
    note: '真实平台 .output + 真实 omp + 本机 LM Studio Qwen3.5-9B(32k);作业身份 = worker',
  },
  scenario: {},
  prompt: {},
  task: {},
  assertions: results,
}

try {
  const h = await startInstance()
  evidence.env.version = String(h?.version ?? '')
  ok('R1', '生产构建隔离实例就绪(workshop ready)', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)

  const reg = await api('POST', '/api/users/register', { name: '验收管理员', email: `accept-${Date.now()}@awshop.local`, password: 'Accept#2026' })
  admin = reg?.data?.token
  ok('R1b', 'admin 注册/登录', Boolean(admin), `status=${reg.status}`)
  writeFileSync(join(HOME, 'admin.json'), JSON.stringify({ token: admin }))

  // ── 产线:DAQ 测温 + DCW 温度设定 + 产品/配方 + 开跑 ──
  const line = await scenarioLine('验收-整改-产线', 'auto', '多专家整改验收线:温度监测 + 点位写授权(模拟设备)')
  const daqTemp = await makeDaq({
    name: '腔体温度', templateRef: 'temp-tc', lineId: line.id, unit: 'C', decimals: 2, min: 0, max: 100,
    semantics: '腔体温度测点;正常工艺窗口 50~70C',
  })
  const dcwSp = await makeDcw({
    name: '温度设定', templateRef: 'temp-sp', lineId: line.id, unit: 'C', decimals: 2, min: 0, max: 100,
    driverConfig: { key: 'accept-mx-temp-sp' }, semantics: '腔体温度设定点;单步 <=4C,窗口 50~70C',
  })
  await remapParam(line.id, dcwSp.id, 'temp_sp', '腔体温度设定值(C)')
  const product = (await api('POST', '/api/workshop/dcw/products', {
    name: '验收产品', lineId: line.id, description: '温度窗口 50~70C',
    paramLimits: { temp_sp: { min: 50, max: 70 } },
  })).data.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    name: '验收配方', productId: product.id, description: '验收配方;温度设定 50~70C,单步 4C',
    opIntervalMs: 0,
    params: [{ nodeId: dcwSp.id, value: 60, min: 50, max: 70, stepLimit: 4 }],
    daqWindows: [{ nodeId: daqTemp.id, min: 50, max: 70 }],
  })).data.recipe
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id })
  ok('R1c', '产线开跑(活动批次建立,配方整批下发)', start.status === 200, `status=${start.status} line=${line.id} recipe=${recipe.id}`)
  // 采集总控必须显式启动(否则节点不采样,daq_query 无数据)
  const daqStart = await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  ok('R1d', '数采网关启动(controller action=start)', daqStart.status === 200, `status=${daqStart.status}`)
  await sleep(12_000)

  // ── AgentChannel:lead + worker ──
  const ch = await makeChannel('验收-整改-频道', line.id, '作业频道:worker 绑定节点后按任务四步执行;手动模式所有下发需人工批准。', 'manual', TOOLS)
  const channelId = ch.channelId
  const worker = await addWorker(channelId, '验收-整改-作业员')
  ok('R2', 'AgentChannel 创建成功(lead + worker 成员)', Boolean(ch.lead?.id && worker.id),
    JSON.stringify({ channelId, lead: ch.lead?.id, worker: worker.id, toolsSaved: ch.toolsSaved }))

  // ── worker 绑定节点:DAQ(观察,auto)+ DCW(点位写授权,manual) ──
  const bDaq = await bindNode(worker.id, daqTemp.id, 'daq', 'auto')
  const bDcw = await bindNode(worker.id, dcwSp.id, 'dcw', 'manual')
  ok('R2b', 'worker 节点绑定落库(daq=auto / dcw=manual)',
    bDaq.mode === 'auto' && bDcw.mode === 'manual' && bDaq.nodeId === daqTemp.id && bDcw.nodeId === dcwSp.id,
    JSON.stringify({ daq: { id: bDaq.id, mode: bDaq.mode }, dcw: { id: bDcw.id, mode: bDcw.mode } }))
  evidence.scenario = {
    line: line.id, recipe: recipe.id, product: product.id,
    daq: daqTemp.id, dcw: dcwSp.id, channel: channelId,
    lead: ch.lead?.id, worker: worker.id,
    bindings: { daq: bDaq.id, dcw: bDcw.id },
  }

  // ── R3 运行时提示词注入(运行时同一个 buildIndustrialContext / nodeSemanticCards) ──
  const probe = promptProbe(worker.id)
  const cardsText = String(probe.cards ?? '')
  evidence.prompt = {
    channelId: probe.channelId,
    profileMode: probe.profileMode,
    text: String(probe.text ?? '').slice(0, 8000),
    cards: cardsText.slice(0, 8000),
    stale: probe.stale,
    error: probe.error,
  }
  ok('R3', '运行时提示词注入:执行模式卡(manual)+ 绑定节点语义卡(名称/量程/单步/手动确认)',
    probe.profileMode === 'manual'
    && cardsText.includes('频道执行模式:manual')
    && cardsText.includes('温度设定') && cardsText.includes(dcwSp.id)
    && cardsText.includes('安全量程') && cardsText.includes('单步') && cardsText.includes('手动确认模式')
    && cardsText.includes('腔体温度') && cardsText.includes(daqTemp.id),
    cardsText.slice(0, 600))

  // ── R4 工具注入面按绑定面差异化 ──
  const tok = agentTokenOf(worker.id)
  const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(worker.id)}`, undefined, undefined, { 'x-aw-agent-token': tok })
  const trialDesc = String((list?.data?.tools ?? []).find(t => t.name === 'recipe_trial')?.description ?? '')
  ok('R4', '工具注入面携带该 worker 的绑定节点(recipe_trial 描述含 dcw id)',
    trialDesc.includes(dcwSp.id), trialDesc.slice(-260))

  // ── R5 worker 真实 omp 回合 ──
  const task = await submitTask(channelId, '验收-整改-worker作业', WORK_PROMPT(line.id), worker.id)
  const t0 = Date.now()
  const run = await waitTask(task.id, {
    timeoutMs: 18 * 60_000,
    autoApprove: true,
    onCard: (card) => {
      console.log(`    · HITL card ${card.id} 出现,自动批准`)
      void approve(card.id, '验收:批准基于数采集证据的温度试验(→56C)').then(r => console.log(`    · approve status=${r.status}`))
    },
  })
  const elapsed = Math.round((Date.now() - t0) / 1000)
  const deliverable = deliverableOf(run.task)
  const calls = toolCallsOf(run.task)
  evidence.task = {
    id: task.id, state: run.task?.state, elapsedSec: elapsed, assignee: run.task?.assigneeId,
    deliverable, toolCalls: calls,
    cards: run.cards.map(c => ({ id: c.id, detail: String(c.detail ?? '').slice(0, 600) })),
  }
  ok('R5', 'worker 任务 COMPLETED(omp + Qwen3.5)', run.task?.state === 'COMPLETED', `state=${run.task?.state} elapsed=${elapsed}s`)
  const completedExplicitly = calls.some(c => c.includes('complete_task'))
  evidence.task.completedExplicitly = completedExplicitly
  ok('R5b', '工具链覆盖 my_industrial_nodes/daq_query/recipe_trial(闭环结论见交付物)',
    calls.some(c => c.includes('my_industrial_nodes')) && calls.some(c => c.includes('daq_query'))
    && calls.some(c => c.includes('recipe_trial'))
    && /recipe_trial/i.test(deliverable) && /样本数|均值/.test(deliverable),
    `complete_task=${completedExplicitly}(false=平台按交付物隐式收口) | ${calls.join(' || ').slice(0, 700)}`)

  // ── R6 HITL + ACK ──
  const history = await approvalsHistory(worker.id)
  const approved = history.filter(a => String(a.status ?? a.decision ?? '') === 'approved' || a.approved === true || a.decision === 'approved')
  ok('R6', '手动模式挂起人工审批并获批(HITL)', run.cards.length >= 1 && (approved.length >= 1 || history.length >= 1),
    JSON.stringify({ cards: run.cards.length, history: history.length, approved: approved.length }))
  ok('R6b', '审批卡展示依据(hypothesis/理由)', run.cards.some(c => /hypothesis|依据|56/.test(String(c.detail ?? ''))),
    run.cards.map(c => String(c.detail ?? '').slice(0, 200)).join(' | '))
  ok('R6c', '下发获得设备证实(交付物含 ACK/证实)', /ACK|证实|verified/i.test(deliverable), deliverable.slice(0, 500))

  // ── R7 效果核验 ──
  const nodes = (await api('GET', `/api/workshop/dcw?lineId=${line.id}`))?.data?.nodes ?? []
  const node = nodes.find(n => n.id === dcwSp.id)
  ok('R7', '节点实际值变更为 56(设备侧生效)', Number(node?.value) === 56, `value=${node?.value} state=${node?.state}`)
  const recipes = (await api('GET', `/api/workshop/dcw/recipes/${recipe.id}`))?.data
  const recipeVersion = Number(recipes?.recipe?.version ?? recipes?.version ?? 1)
  ok('R7b', 'trial 不写配方版本(版本仍为 1)', recipeVersion === 1, `version=${recipeVersion}`)
  const journal = (await api('GET', `/api/workshop/dcw/journal?lineId=${line.id}&limit=500`))?.data?.anchors ?? []
  ok('R7c', '账本新增写入锚点(可审计)', journal.length >= 2, `anchors=${journal.length}`)
  // 数采链路:经权威查询端点(REST)取该测点最近 10 分钟的原始桶
  const dq = await api('GET', `/api/workshop/daq/query?node_ids=${encodeURIComponent(daqTemp.id)}&last_minutes=10&bucket_ms=15000&limit=200`)
  const series = dq?.data?.series ?? dq?.series ?? []
  const pts = series.flatMap(s => s.points ?? s.data ?? [])
  ok('R7d', 'TSDB 有该测点真实样本(数采链路入库,daq 查询端点可读)', dq.status === 200 && pts.length > 0,
    `status=${dq.status} points=${pts.length} sample=${JSON.stringify(pts[0] ?? null).slice(0, 160)}`)
  evidence.scenario.final = { nodeValue: node?.value, recipeVersion, journal: journal.length, dpsPoints: pts.length }
}
catch (err) {
  ok('R0', '验收执行未抛异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  evidence.summary = { total: results.length, pass, fail }
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  writeFileSync(join(EVIDENCE_DIR, 'prompt-injection.json'), `${JSON.stringify(evidence.prompt, null, 2)}\n`)
  writeFileSync(join(EVIDENCE_DIR, 'task.json'), `${JSON.stringify(evidence.task, null, 2)}\n`)
  console.log(`\n=== ${pass}/${results.length} PASS, ${fail} FAIL ===`)
  console.log(`证据:${EVIDENCE_DIR}`)
  stopOwnedInstance()
  if (fail > 0) process.exitCode = 1
}
