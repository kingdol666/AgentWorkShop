#!/usr/bin/env node
/**
 * 节点级写授权(双轨)× 三模式 真实 harness 验收(2026-10-28)。
 *
 * 真实平台(.output 生产构建)+ 真实 omp 子进程 + 本机 LM Studio Qwen3.5-9B(32k 上下文),
 * 三个 Channel 分别 observe / manual / auto;Agent 只持 **dcw 节点绑定(点位写授权)**,
 * 不绑配方 —— 验证「授权跟设备走、管控跟活动配方走」在真实 Agent 回合里成立:
 *   - observe:只读数采并给出分析结论,产线零写入;
 *   - manual :频道层钳位 → recipe_trial 挂人工审批,批准后 60→58,ACK 证实,版本不变;
 *   - auto   :全链 auto → recipe_trial 免批直执行,60→62,ACK 证实。
 * 另检查 IDD 集成(插件在位/后端可达/不启动分析)与工具注入面(节点授权清单)。
 *
 * 运行:node scripts/e2e-node-binding-3mode-real.mjs
 * 环境:LM Studio 127.0.0.1:1234 模型 qwen3.5-9b-32k;隔离实例 PORT=3410。
 * 证据:docs/audit/evidence/2026-10-28-node-binding-3mode/report.json
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = 'D:/codes/ABO/AgentWorkShop'
const HOME = process.env.AW_ACCEPT_HOME ?? 'D:/tmp/aw-node-scoped-ustc-20261029'
const PORT = Number(process.env.AW_ACCEPT_PORT ?? 3410)
const BASE = `http://127.0.0.1:${PORT}`
const MODEL = { provider: 'ustc', model: 'deepseek-flash', contextTokens: 131072 }
const MODEL_LLM = { provider: MODEL.provider, model: MODEL.model }
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-ralph-full-acceptance', 'three-mode')
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
  // 先清掉本目录上次留下的实例(pid 文件来自本验收目录,杀的是我们自己起的进程)
  stopOwnedInstance()
  await sleep(1500)
  const running = await health()
  if (running) throw new Error(`端口 ${PORT} 已被非本验收实例占用:${running.app} ${running.version}`)
  if (process.env.AW_ACCEPT_RESET !== '0') {
    if (!/aw-node-scoped/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
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
      NUXT_SESSION_PASSWORD: 'node-scoped-ustc-20261029-session-key-abc',
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
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const h = await health()
    if (h?.workshop === 'ready') return h
  }
  throw new Error('隔离实例未在 90s 内就绪')
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

async function channelAgents(channelId) {
  const d = await api('GET', `/api/workshop/channels/${channelId}`)
  return d?.data?.agents ?? []
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
    .map(t => t.replace(/\s+/g, ' ').slice(0, 200))
}

async function waitTask(taskId, { timeoutMs = 12 * 60_000, autoApprove = false, onCard = null } = {}) {
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
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state)) return { task, cards, timedOut: false }
    await sleep(3000)
  }
  const r = await api('GET', `/api/workshop/tasks/${taskId}`)
  return { task: taskOf(r), cards, timedOut: true }
}

async function submitTask(channelId, title, description) {
  const r = await api('POST', `/api/workshop/channels/${channelId}/tasks`, { title, description })
  const task = taskOf(r)
  if (!task?.id) throw new Error(`任务创建失败: ${JSON.stringify(r).slice(0, 400)}`)
  return task
}

function scenarioLine(name, controlMode, description) {
  return api('POST', '/api/workshop/dcw/lines', { name, simulated: true, controlMode, description }).then(r => r.data.line)
}

async function makeDaq(attrs) {
  return (await api('POST', '/api/workshop/daq', {
    driver: 'mock',
    intervalMs: 1000,
    enabled: true,
    publishIntervalMs: 0,
    ...attrs,
  })).data.node
}

async function makeDcw(attrs) {
  return (await api('POST', '/api/workshop/dcw', {
    driver: 'mock',
    enabled: true,
    holdIntervalMs: 0,
    readIntervalMs: 0,
    writeLockSeconds: 0,
    stepLimit: 5,
    ...attrs,
  })).data.node
}

async function remapParam(lineId, nodeId, key, desc) {
  const params = (await api('GET', `/api/workshop/dcw/params?lineId=${lineId}`)).data.params ?? []
  const pm = params.find(p => p.nodeId === nodeId)
  if (!pm) throw new Error(`参数映射不存在: node=${nodeId}`)
  await api('PATCH', `/api/workshop/dcw/params/${pm.id}`, { key, desc, min: 0, max: 100 })
}

async function makeChannel(name, lineId, scenarioPrompt, mode, toolNames) {
  const ch = (await api('POST', '/api/workshop/channels', {
    name,
    lineId,
    scenarioPrompt,
    // 本机 9B 模型易被 omp 原生命令(bash/glob/edit/read 任意路径)带偏:
    // --no-tools 关闭全部内置工具,只保留 set_host_tools 注入的 host 工具(本次 4~5 个),
    // 让回合严格收敛在任务步骤上;这也是小模型在真实 harness 里的推荐配置。
    leadAgent: { name: `${name}-线长`, harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools'] } },
  })).data
  const channelId = ch?.channelId
  if (!channelId) throw new Error(`频道创建失败: ${JSON.stringify(ch).slice(0, 300)}`)
  await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: MODEL_LLM })
  await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, mode === 'auto' ? { mode: 'auto', confirm: true } : { mode })
  const put = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
    mode: 'selected',
    tools: toolNames.map(n => ({ name: n, enabled: true })),
  })
  const agents = await channelAgents(channelId)
  const lead = agents.find(a => a.role === 'lead')
  return { channelId, lead, toolsSaved: put.status, agents }
}

async function bind(agentId, nodeId, kind) {
  return api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, mode: 'auto' })
}

async function bindAuto(agentId, nodeId, kind) {
  const b = await bind(agentId, nodeId, kind)
  const id = b?.data?.binding?.id
  if (id && b?.data?.binding?.mode === 'manual') {
    await api('PATCH', `/api/workshop/agent-tools/bindings/${id}`, { mode: 'auto', confirm: true })
  }
  return b
}

const OBS_PROMPT = [
  '你是观察模式频道(只读)的工艺分析员。严格按三步执行,不要做别的:',
  '1) 调用 line_context 获取你负责的产线与活动批次;',
  '2) 调用 daq_query(line_id 用上一步返回值,last_minutes=5,bucket_ms=15000,limit=500);',
  '3) 用 complete_task 提交结论:每个测点的样本数/均值/最小值/最大值,以及是否超出温度窗口 50~70C。',
  '禁止调用任何写工具或配方工具。',
].join('\n')

function opsPrompt(value, lineId) {
  return [
    '你是工艺闭环频道的操作员。严格按三步执行,不要做别的:',
    '1) 调用 my_industrial_nodes 查看你绑定的数控节点(记下节点 id;只允许操作它);',
    '2) 调用 recipe_trial:line_id="' + lineId + '",params 只包含你绑定的那个数控节点,value=' + value + ',hypothesis 写「验收:活动配方温控试验,目标 ' + value + 'C」;审批由人工处理,工具会返回结果,你不需要等待;',
    '3) 立即调用 complete_task 提交 recipe_trial 的完整回执原文与批次 id。',
    '本任务只做这三步:禁止复测、禁止等待/睡眠、禁止 recipe_update/rollback、禁止使用 bash/终端/后台任务(除 read(xd://…) 查看工具说明外不要用其他工具)。',
  ].join('\n')
}

// 最小工具面:只留任务必需的 5 个,避免 9B 本地模型在长工具目录里发散探索
const OPS_TOOLS = [
  'my_industrial_nodes',
  'recipe_trial',
  'recipe_rollback',
  'complete_task',
  'report_progress',
]
// observe 模式下 my_industrial_nodes 被分发面判为写面工具(EXEC_MODE_OBSERVE),不得进 allow-list;
// 其余也只留任务必需的 4 个,避免本地 9B 模型在工具目录里发散探索
const OBS_TOOLS = ['line_context', 'daq_query', 'complete_task', 'report_progress']

const evidence = {
  at: new Date().toISOString(),
  env: {
    base: BASE,
    home: HOME,
    version: '',
    model: MODEL,
    harness: 'omp',
    devices: 'mock(daq+dcw)',
    note: '真实平台 + 真实 omp 子进程 + 本地 Qwen3.5-9B(32k);设备为内置 mock,无物理响应耦合',
  },
  scenario: {},
  tasks: {},
  assertions: results,
  idd: {},
}

async function journalCount(lineId) {
  const r = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=500`)
  return r?.data?.anchors ?? []
}

/** 等待「控制链完成」而不是死等 LLM 自己收口:审批自动放行,账本出现点位写入后
 *  再给模型 15s 调 complete_task;仍未收口则由平台取消任务(控制链证据已成立)。 */
async function waitTrialAndClose(taskId, agentId, lineId, nodeId, opts = {}) {
  const started = Date.now()
  const since = started - 5000
  const cards = []
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000
  const expectNoHitl = opts.expectNoHitl === true
  while (Date.now() - started < timeoutMs) {
    const task = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
    const state = String(task?.state ?? '')
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state)) return { task, cards, cancelled: false, timedOut: false }
    const pending = await pendingOf(agentId)
    for (const card of pending) {
      if (cards.some(c => c.id === card.id)) continue
      cards.push(card)
      console.log(`    · HITL card ${card.id} 出现,自动批准`)
      await approve(card.id, expectNoHitl ? '验收:自动模式出现审批(记录并放行)' : opts.approvalComment ?? '验收:批准手动模式点位试验')
    }
    const hit = (await journalCount(lineId)).some(a =>
      a.nodeId === nodeId && a.prevValue === opts.prevValue && a.newValue !== opts.prevValue && Date.parse(a.at) >= since)
    if (hit) {
      await sleep(15_000)
      const t2 = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(t2?.state ?? ''))) return { task: t2, cards, cancelled: false, timedOut: false }
      await api('POST', `/api/workshop/tasks/${taskId}/cancel`, {
        reason: '验收:控制链已完成,LLM 未在时限内调用 complete_task,平台侧取消收敛',
      }, admin)
      const t3 = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
      return { task: t3, cards, cancelled: true, timedOut: false }
    }
    await sleep(2000)
  }
  return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cards, cancelled: false, timedOut: true }
}

try {
  const h = await startInstance()
  evidence.env.version = String(h?.version ?? '')
  ok('R0', '生产构建隔离实例就绪(workshop ready)', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)

  const reg = await api('POST', '/api/users/register', { name: '验收管理员', email: `accept-${Date.now()}@awshop.local`, password: 'Accept#2026' })
  admin = reg?.data?.token
  ok('R0b', 'admin 注册/登录', Boolean(admin), `status=${reg.status}`)
  writeFileSync(join(HOME, 'admin.json'), JSON.stringify({ token: admin }))

  // IDD 集成面:启用三个插件(只启用,不启动任何分析)
  for (const name of ['idd-closedloop-bridge', 'diag-bridge', 'rag-bridge']) {
    const en = await api('POST', `/api/workshop/plugins/${name}/enable`, undefined, admin)
    if (en.status !== 200) console.log(`    · 插件 ${name} 启用返回 ${en.status}: ${String(en?.message ?? '').slice(0, 120)}`)
  }

  // ── 两条线:观察线(只读数采)、写入线(两条 DCW + 配方) ──
  const obsLine = await scenarioLine('验收-观察线', 'auto', '观察线:薄膜腔体温度/压力监测(模拟设备;真实平台/真实 Agent)')
  const writeLine = await scenarioLine('验收-写入线', 'auto', '写入线:薄膜腔体温度点位授权验收(模拟设备;真实平台/真实 Agent)')

  const obsDaqTemp = await makeDaq({
    name: '腔体温度(观察线)', templateRef: 'temp-tc', lineId: obsLine.id, unit: 'C', decimals: 2, min: 0, max: 100,
    semantics: '腔体温度测点;正常工艺窗口 50~70C',
  })
  const obsDaqPress = await makeDaq({
    name: '系统压力(观察线)', templateRef: 'pressure-tx', lineId: obsLine.id, unit: 'bar', decimals: 2, min: 0, max: 10,
    semantics: '系统压力测点;稳定在 4~6 bar',
  })
  const obsDcw = await makeDcw({
    name: '温度设定(观察线)', templateRef: 'temp-sp', lineId: obsLine.id, unit: 'C', decimals: 2, min: 0, max: 100,
    driverConfig: { key: 'accept-obs-temp-sp' }, semantics: '观察线温度设定(观察频道不可写)',
  })
  await remapParam(obsLine.id, obsDcw.id, 'obs_temp_sp', '观察线腔体温度设定值(C)')
  const obsProduct = (await api('POST', '/api/workshop/dcw/products', {
    name: '验收产品-观察线', lineId: obsLine.id, description: '观察线产品;温度窗口 50~70C',
    paramLimits: { obs_temp_sp: { min: 50, max: 70 } },
  })).data.product
  const obsRecipe = (await api('POST', '/api/workshop/dcw/recipes', {
    name: '验收配方-观察线', productId: obsProduct.id, description: '观察线配方(仅用于建立活动批次)',
    opIntervalMs: 0,
    params: [{ nodeId: obsDcw.id, value: 60, min: 50, max: 70, stepLimit: 4 }],
    daqWindows: [{ nodeId: obsDaqTemp.id, min: 50, max: 70 }],
  })).data.recipe

  const writeDaq = await makeDaq({
    name: '腔体温度(写入线)', templateRef: 'temp-tc', lineId: writeLine.id, unit: 'C', decimals: 2, min: 0, max: 100,
    semantics: '腔体温度测点;与温度设定存在 20~60s 响应滞后(本验收为 mock 设备,无物理耦合)',
  })
  const dcwA = await makeDcw({
    name: '温度设定A(写入线)', templateRef: 'temp-sp', lineId: writeLine.id, unit: 'C', decimals: 2, min: 0, max: 100,
    driverConfig: { key: 'accept-write-a' }, semantics: '手动频道 Agent 的点位授权节点;单步 <=4C,窗口 50~70C',
  })
  const dcwB = await makeDcw({
    name: '温度设定B(写入线)', templateRef: 'temp-sp', lineId: writeLine.id, unit: 'C', decimals: 2, min: 0, max: 100,
    driverConfig: { key: 'accept-write-b' }, semantics: '自动频道 Agent 的点位授权节点;单步 <=4C,窗口 50~70C',
  })
  await remapParam(writeLine.id, dcwA.id, 'temp_sp_a', '写入线温度设定A(C)')
  await remapParam(writeLine.id, dcwB.id, 'temp_sp_b', '写入线温度设定B(C)')
  const writeProduct = (await api('POST', '/api/workshop/dcw/products', {
    name: '验收产品-写入线', lineId: writeLine.id, description: '写入线产品;两路温度设定窗口 50~70C',
    paramLimits: { temp_sp_a: { min: 50, max: 70 }, temp_sp_b: { min: 50, max: 70 } },
  })).data.product
  const writeRecipe = (await api('POST', '/api/workshop/dcw/recipes', {
    name: '验收配方-写入线', productId: writeProduct.id, description: '写入线配方;两路 DCW 参数各由不同 Agent 点位授权',
    opIntervalMs: 0,
    params: [
      { nodeId: dcwA.id, value: 60, min: 50, max: 70, stepLimit: 4 },
      { nodeId: dcwB.id, value: 60, min: 50, max: 70, stepLimit: 4 },
    ],
    daqWindows: [{ nodeId: writeDaq.id, min: 50, max: 70 }],
  })).data.recipe

  const startObs = await api('POST', `/api/workshop/dcw/lines/${obsLine.id}/start`, { recipeId: obsRecipe.id })
  const startWrite = await api('POST', `/api/workshop/dcw/lines/${writeLine.id}/start`, { recipeId: writeRecipe.id })
  ok('R1', '两线开跑(活动批次建立,配方整批下发)', startObs.status === 200 && startWrite.status === 200,
    `obs=${startObs.status} write=${startWrite.status}`)

  await sleep(12_000)

  // ── 三个 Channel(真实 omp) ──
  const obsCh = await makeChannel('验收-三模式-观察', obsLine.id, '观察模式频道:只做数采与工艺分析,物理零写。', 'observe', OBS_TOOLS)
  const manualCh = await makeChannel('验收-三模式-手动', writeLine.id, '手动模式频道:每次配方试验都必须经人工批准;只操作你绑定的点位。验收场景只执行任务描述,不复测、不等待、不固化;未收到任务时禁止自主发起任何下发。', 'manual', OPS_TOOLS)
  const autoCh = await makeChannel('验收-三模式-自动', writeLine.id, '自动模式频道:限界内自动执行配方试验;只操作你绑定的点位。验收场景只执行任务描述,不复测、不等待、不固化;未收到任务时禁止自主发起任何下发。', 'auto', OPS_TOOLS)
  ok('R2', '三频道创建 + 执行模式 + 工具面(omp/selected)', Boolean(obsCh.channelId && manualCh.channelId && autoCh.channelId) && obsCh.toolsSaved === 200 && manualCh.toolsSaved === 200 && autoCh.toolsSaved === 200,
    JSON.stringify({ obs: obsCh.channelId, manual: manualCh.channelId, auto: autoCh.channelId, tools: [obsCh.toolsSaved, manualCh.toolsSaved, autoCh.toolsSaved] }))

  const obsLead = obsCh.lead
  const manualLead = manualCh.lead
  const autoLead = autoCh.lead

  // 节点绑定:观察=daq;手动/自动=各自的 dcw 点位(不绑配方)
  const obsBind = await bindAuto(obsLead.id, obsDaqTemp.id, 'daq')
  const manualBind = await bindAuto(manualLead.id, dcwA.id, 'dcw')
  const autoBind = await bindAuto(autoLead.id, dcwB.id, 'dcw')
  ok('R2b', '点位绑定落库(观察=daq,手动/自动=各自 dcw;无配方绑定)',
    obsBind.status === 200 && manualBind.status === 200 && autoBind.status === 200,
    `status=${obsBind.status}/${manualBind.status}/${autoBind.status} kinds=${obsBind?.data?.binding?.kind}/${manualBind?.data?.binding?.kind}/${autoBind?.data?.binding?.kind}`)

  const tok = { obs: agentTokenOf(obsLead.id), manual: agentTokenOf(manualLead.id), auto: agentTokenOf(autoLead.id) }
  const descOf = async (agentId, token) => {
    const r = await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agentId)}`, undefined, undefined, { 'x-aw-agent-token': token })
    return (r?.data?.tools ?? []).find(t => t.name === 'recipe_trial')?.description ?? ''
  }
  const descManual = String(await descOf(manualLead.id, tok.manual))
  const descAuto = String(await descOf(autoLead.id, tok.auto))
  ok('R2c', '工具注入面按 Agent 点位授权差异化(手动只见A,自动只见B)',
    descManual.includes(dcwA.id) && !descManual.includes(dcwB.id) && descAuto.includes(dcwB.id) && !descAuto.includes(dcwA.id),
    `manual=${descManual.slice(-180)} | auto=${descAuto.slice(-180)}`)

  evidence.scenario = {
    lines: { obs: obsLine.id, write: writeLine.id },
    recipes: { obs: obsRecipe.id, write: writeRecipe.id },
    dcw: { a: dcwA.id, b: dcwB.id },
    daq: { obsTemp: obsDaqTemp.id, obsPress: obsDaqPress.id, write: writeDaq.id },
    channels: { obs: obsCh.channelId, manual: manualCh.channelId, auto: autoCh.channelId },
    agents: { obs: obsLead.id, manual: manualLead.id, auto: autoLead.id },
    bindings: { obs: obsBind?.data?.binding?.id, manual: manualBind?.data?.binding?.id, auto: autoBind?.data?.binding?.id },
  }

  const obsJournalBefore = (await journalCount(obsLine.id)).length

  // ── 观察模式任务 ──
  const obsTask = await submitTask(obsCh.channelId, '验收-观察模式-数采分析', OBS_PROMPT)
  const t0 = Date.now()
  const obsRun = await waitTask(obsTask.id, { timeoutMs: 12 * 60_000 })
  const obsDeliverable = deliverableOf(obsRun.task)
  const obsJournalAfter = await journalCount(obsLine.id)
  const obsHistory = await approvalsHistory(obsLead.id)
  ok('R3', '观察模式任务 COMPLETED', obsRun.task?.state === 'COMPLETED', `state=${obsRun.task?.state} elapsed=${Math.round((Date.now() - t0) / 1000)}s`)
  ok('R3b', '观察结论含样本统计与温度窗口判定', /样本|均值|最小|最大/.test(obsDeliverable) && /50|70|窗口/.test(obsDeliverable), obsDeliverable.slice(0, 400))
  ok('R3c', '观察模式产线零写入(账本条数不增)', obsJournalAfter.length === obsJournalBefore, `before=${obsJournalBefore} after=${obsJournalAfter.length}`)
  ok('R3d', '观察模式无写审批(只读频道)', obsHistory.length === 0, `approvals=${obsHistory.length}`)
  evidence.tasks.obs = { id: obsTask.id, state: obsRun.task?.state, elapsedSec: Math.round((Date.now() - t0) / 1000), deliverable: obsDeliverable, toolCalls: toolCallsOf(obsRun.task) }

  // ── 手动模式任务(频道钳位 → HITL)。基线取提交时设备现值(值无关断言)。 ──
  const nodesPreManual = await api('GET', '/api/workshop/dcw')
  const preManualA = Number((nodesPreManual?.data?.nodes ?? []).find(n => n.id === dcwA.id)?.value)
  const manualTask = await submitTask(manualCh.channelId, '验收-手动模式-点位试验', opsPrompt(Number.isFinite(preManualA) ? Math.min(preManualA + 2, 70) : 58, writeLine.id))
  const m0 = Date.now()
  const manualRun = await waitTrialAndClose(manualTask.id, manualLead.id, writeLine.id, dcwA.id, {
    prevValue: preManualA,
    approvalComment: '验收:批准手动模式点位试验',
  })
  const writeJournal = await journalCount(writeLine.id)
  const manualEntries = writeJournal.filter(a => a.nodeId === dcwA.id && a.prevValue === preManualA && a.newValue !== preManualA && Date.parse(a.at) >= m0 - 5000)
  const manualTrial = manualEntries[0]
  const manualHistory = await approvalsHistory(manualLead.id)
  const manualCard = manualRun.cards[0]
  const manualCardRow = manualCard ? manualHistory.find(a => a.id === manualCard.id) : null
  const manualNode = await api('GET', '/api/workshop/dcw')
  const manualNodeRow = (manualNode?.data?.nodes ?? []).find(n => n.id === dcwA.id)
  ok('R4', '手动模式控制链完成(HITL → 点位写授权下发)', Boolean(manualTrial), `journal=${JSON.stringify(manualTrial ?? null)} task=${manualRun.task?.state}`)
  ok('R4a', '手动模式触发人工审批(频道 manual 钳位)', manualRun.cards.length >= 1, `cards=${manualRun.cards.map(c => c.id).join(',')}`)
  ok('R4b', '人工审批落定 approved(附言回流)', manualCardRow?.status === 'approved', `card=${manualCard?.id} status=${manualCardRow?.status} comment=${manualCardRow?.comment}`)
  ok('R4c', `手动模式点位写入落账 ${preManualA}→${manualTrial?.newValue ?? '?'}(点位写授权,无配方绑定)`,
    Boolean(manualTrial) && Number(manualTrial.newValue) >= 50 && Number(manualTrial.newValue) <= 70,
    JSON.stringify(manualTrial ?? null).slice(0, 400))
  ok('R4d', '手动模式设备侧现值=账本新值(独立回读)', Number(manualNodeRow?.value) === Number(manualTrial?.newValue),
    `value=${manualNodeRow?.value} journal=${manualTrial?.newValue}`)
  const versions = await api('GET', `/api/workshop/dcw/recipes/${writeRecipe.id}/versions`)
  const versionRows = versions?.data?.versions ?? versions?.data ?? []
  ok('R4e', '试验不写配方版本(仍为 v1)', (versionRows[0]?.version ?? 1) === 1, `versions=${versionRows.map(v => v.version).join(',')}`)
  ok('R4f', '任务收口(模型 complete_task 或平台取消收敛)', manualRun.task?.state === 'COMPLETED' || manualRun.cancelled,
    `state=${manualRun.task?.state} cancelledByOperator=${manualRun.cancelled}`)
  evidence.tasks.manual = {
    id: manualTask.id, state: manualRun.task?.state, cancelledByOperator: manualRun.cancelled,
    elapsedSec: Math.round((Date.now() - m0) / 1000), deliverable: deliverableOf(manualRun.task),
    toolCalls: toolCallsOf(manualRun.task),
    hitl: manualRun.cards.map(c => ({ id: c.id, status: c.status, detail: c.detail, payload: c.payload })),
    hitlHistory: manualHistory.map(a => ({ id: a.id, status: a.status, comment: a.comment, decidedBy: a.decidedBy })),
    journal: manualEntries.slice(-3), approvals: manualCard ? manualCard.id : null,
  }

  // ── 自动模式任务(全链 auto,免批)。基线取提交时设备现值(值无关断言,
  //    模型可自选 +2C 内的候选);opsPrompt 里的候选值仅为引导。 ──
  const nodesPreAuto = await api('GET', '/api/workshop/dcw')
  const preAutoB = Number((nodesPreAuto?.data?.nodes ?? []).find(n => n.id === dcwB.id)?.value)
  const autoTask = await submitTask(autoCh.channelId, '验收-自动模式-点位试验', opsPrompt(Number.isFinite(preAutoB) ? Math.min(preAutoB + 2, 70) : 62, writeLine.id))
  const a0 = Date.now()
  const autoRun = await waitTrialAndClose(autoTask.id, autoLead.id, writeLine.id, dcwB.id, {
    prevValue: preAutoB,
    expectNoHitl: true,
  })
  const autoHistory = await approvalsHistory(autoLead.id)
  const autoCardsInWindow = autoHistory.filter(a => Date.parse(a.createdAt ?? 0) >= a0 - 5000)
  const autoEntries = (await journalCount(writeLine.id)).filter(a => a.nodeId === dcwB.id && a.prevValue === preAutoB && a.newValue !== preAutoB && Date.parse(a.at) >= a0 - 5000)
  const autoTrial = autoEntries[0]
  const autoNode = await api('GET', '/api/workshop/dcw')
  const autoNodeRow = (autoNode?.data?.nodes ?? []).find(n => n.id === dcwB.id)
  ok('R5', '自动模式控制链完成(免批 → 点位写授权下发)', Boolean(autoTrial), `journal=${JSON.stringify(autoTrial ?? null)} task=${autoRun.task?.state}`)
  ok('R5a', '自动模式全程无人工审批(全链 auto)', autoRun.cards.length === 0 && autoCardsInWindow.length === 0,
    `cards=${autoRun.cards.length} historyInWindow=${autoCardsInWindow.length}`)
  ok('R5b', `自动模式点位写入落账 ${preAutoB}→${autoTrial?.newValue ?? '?'}(点位写授权,无配方绑定)`,
    Boolean(autoTrial) && Number(autoTrial.newValue) >= 50 && Number(autoTrial.newValue) <= 70,
    JSON.stringify(autoTrial ?? null).slice(0, 400))
  ok('R5c', '自动模式设备侧现值=账本新值(独立回读)', Number(autoNodeRow?.value) === Number(autoTrial?.newValue),
    `value=${autoNodeRow?.value} journal=${autoTrial?.newValue}`)
  ok('R5d', '任务收口(模型 complete_task 或平台取消收敛)', autoRun.task?.state === 'COMPLETED' || autoRun.cancelled,
    `state=${autoRun.task?.state} cancelledByOperator=${autoRun.cancelled}`)
  evidence.tasks.auto = {
    id: autoTask.id, state: autoRun.task?.state, cancelledByOperator: autoRun.cancelled,
    elapsedSec: Math.round((Date.now() - a0) / 1000), deliverable: deliverableOf(autoRun.task),
    toolCalls: toolCallsOf(autoRun.task), hitl: autoRun.cards.map(c => ({ id: c.id, status: c.status })), journal: autoEntries.slice(-3),
  }

  // ── 双轨授权复核:同一活动配方、两个 Agent 各写自己的点位,互不越权 ──
  const writeJournalAll = await journalCount(writeLine.id)
  const trialA = writeJournalAll.filter(a => a.nodeId === dcwA.id && a.prevValue === preManualA && a.newValue !== preManualA)
  const trialB = writeJournalAll.filter(a => a.nodeId === dcwB.id && a.prevValue === preAutoB && a.newValue !== preAutoB)
  ok('R6', `同一活动配方下两条轨迹各自落账(A ${preManualA}→${trialA[0]?.newValue ?? '?'}, B ${preAutoB}→${trialB[0]?.newValue ?? '?'})`,
    trialA.length >= 1 && trialB.length >= 1 && trialA[0].recipeRunId !== trialB[0].recipeRunId,
    `A=${JSON.stringify(trialA.slice(0, 1))} B=${JSON.stringify(trialB.slice(0, 1))}`)

  // ── 配方历史 + 统一回退(recipe 绑定 = 配方级操作权;节点下发历史由批次/账本记录) ──
  // 回退是配方级操作:复用自动频道 lead(已有 dcwB 点位绑定),再补一条配方绑定;
  // 前面的三模式试验已在无配方绑定时完成,故不污染「纯点位授权」证据。
  const rbBind = await bindAuto(autoLead.id, writeRecipe.id, 'recipe')
  const patchV2 = await api('PATCH', `/api/workshop/dcw/recipes/${writeRecipe.id}`, {
    params: [
      { nodeId: dcwA.id, value: 56, min: 50, max: 70, stepLimit: 4 },
      { nodeId: dcwB.id, value: 64, min: 50, max: 70, stepLimit: 4 },
    ],
  }, admin)
  const versionsV2 = (await api('GET', `/api/workshop/dcw/recipes/${writeRecipe.id}/versions`))?.data?.versions ?? []
  const v2 = versionsV2.find(v => v.version >= 2 && Array.isArray(v.params) && v.params.some(p => p.nodeId === dcwA.id && p.value === 56))
  ok('R8a', '配方定义版本化(v2 = 56/64,归因用户)', Boolean(rbBind?.data?.binding?.id) && Boolean(v2) && patchV2.status === 200,
    `bind=${rbBind?.data?.binding?.kind} versions=${versionsV2.map(v => v.version).join(',')} patch=${patchV2.status}`)
  const preRb = await journalCount(writeLine.id)
  const preRbA = preRb.find(a => a.nodeId === dcwA.id)
  const preRbB = preRb.find(a => a.nodeId === dcwB.id)
  const rb = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: autoLead.id,
    tool: 'recipe_rollback',
    args: { recipe_id: writeRecipe.id, version: 1, dispatch: true, reason: '验收:统一回退到 v1(历史+回退验证)' },
  }, undefined, { 'x-aw-agent-token': tok.auto })
  const rbText = String(rb?.data?.result?.text ?? rb?.data?.text ?? '')
  ok('R8b', '配方级统一回退(recipe_rollback v1 + dispatch)执行成功', !(rb?.data?.result?.isError ?? rb?.data?.isError) && /统一回退完成/.test(rbText),
    rbText.slice(0, 400))
  const afterRbJournal = await journalCount(writeLine.id)
  const preRbIds = new Set(preRb.map(a => a.id))
  const rbNew = afterRbJournal.filter(a => !preRbIds.has(a.id))
  const rbA = rbNew.filter(a => a.nodeId === dcwA.id && a.newValue === 60 && a.prevValue === preRbA?.newValue)
  const rbB = rbNew.filter(a => a.nodeId === dcwB.id && a.newValue === 60 && a.prevValue === preRbB?.newValue)
  const nodesAfterRb = await api('GET', '/api/workshop/dcw')
  const rbNodeA = (nodesAfterRb?.data?.nodes ?? []).find(n => n.id === dcwA.id)
  const rbNodeB = (nodesAfterRb?.data?.nodes ?? []).find(n => n.id === dcwB.id)
  ok('R8c', `回退逐节点落账(${preRbA?.newValue}→60 / ${preRbB?.newValue}→60,回退批次新账本)`, rbA.length >= 1 && rbB.length >= 1,
    `A=${JSON.stringify(rbA.slice(0, 1))} B=${JSON.stringify(rbB.slice(0, 1))}`)
  ok('R8d', '回退后设备侧恢复 60/60', Number(rbNodeA?.value) === 60 && Number(rbNodeB?.value) === 60,
    `A=${rbNodeA?.value} B=${rbNodeB?.value}`)
  const versionsAfterRb = (await api('GET', `/api/workshop/dcw/recipes/${writeRecipe.id}/versions`))?.data?.versions ?? []
  const v3 = versionsAfterRb.find(v => v.version >= 3 && Array.isArray(v.params)
    && v.params.some(p => p.nodeId === dcwA.id && p.value === 60) && v.params.some(p => p.nodeId === dcwB.id && p.value === 60))
  ok('R8e', '回退生成新版本 v3(定义 60/60,历史 v1/v2 保留)', Boolean(v3),
    `versions=${versionsAfterRb.map(v => `${v.version}:${(v.params ?? []).map(p => p.value).join('/')}`).join(',')}`)
  evidence.rollback = {
    worker: autoLead.id, binding: rbBind?.data?.binding?.id, response: rbText,
    journal: [...rbA.slice(0, 1), ...rbB.slice(0, 1)],
    versions: versionsAfterRb.map(v => ({ version: v.version, values: (v.params ?? []).map(p => p.value), by: v.by })),
  }

  // ── 换配方:活动配方 B 接管 DCW 管控;同一节点绑定 Agent 无需新绑定 ──
  await api('POST', `/api/workshop/dcw/lines/${writeLine.id}/stop`, undefined, admin)
  const recipeB = (await api('POST', '/api/workshop/dcw/recipes', {
    productId: writeProduct.id,
    name: '验收配方-写入线B',
    description: '换配方验收:B 接管两路 DCW 的窗口/目标值与下发',
    opIntervalMs: 0,
    params: [
      { nodeId: dcwA.id, value: 52, min: 50, max: 70, stepLimit: 4 },
      { nodeId: dcwB.id, value: 64, min: 50, max: 70, stepLimit: 4 },
    ],
    daqWindows: [{ nodeId: writeDaq.id, min: 50, max: 70 }],
  })).data?.recipe
  const startB = await api('POST', `/api/workshop/dcw/lines/${writeLine.id}/start`, { recipeId: recipeB.id }, admin)
  await sleep(1500)
  const nodesB = await api('GET', '/api/workshop/dcw')
  const bNodeA = (nodesB?.data?.nodes ?? []).find(n => n.id === dcwA.id)
  const bNodeB = (nodesB?.data?.nodes ?? []).find(n => n.id === dcwB.id)
  ok('R9a', '换配方后 B 的配方参数接管两路 DCW(A=52,B=64)',
    startB.status === 200 && Number(bNodeA?.value) === 52 && Number(bNodeB?.value) === 64,
    `start=${startB.status} A=${bNodeA?.value} B=${bNodeB?.value} run=${startB?.data?.run?.id}`)
  const switchTrial = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: autoLead.id,
    tool: 'recipe_trial',
    args: { line_id: writeLine.id, params: [{ node_id: dcwB.id, value: 66 }], hypothesis: '验收:换配方后活动配方B继续管理DCW下发' },
  }, undefined, { 'x-aw-agent-token': tok.auto })
  const switchText = String(switchTrial?.data?.result?.text ?? switchTrial?.data?.text ?? '')
  ok('R9b', '同一节点绑定 Agent 在换配方后 trial 成功(无需新绑定/无审批)', !(switchTrial?.data?.result?.isError ?? switchTrial?.data?.isError) && /试验已整批下发/.test(switchText),
    switchText.slice(0, 360))
  const switchJournal = (await journalCount(writeLine.id)).filter(a => a.nodeId === dcwB.id && a.newValue === 66 && a.prevValue === 64)
  const nodesAfterSwitch = await api('GET', '/api/workshop/dcw')
  const sNodeA = (nodesAfterSwitch?.data?.nodes ?? []).find(n => n.id === dcwA.id)
  const sNodeB = (nodesAfterSwitch?.data?.nodes ?? []).find(n => n.id === dcwB.id)
  ok('R9c', 'B 的活动批次记录本次下发(A 保持 52,B=66;活动批次属配方 B)',
    switchJournal.length >= 1 && startB?.data?.run?.recipeId === recipeB?.id && Number(sNodeA?.value) === 52 && Number(sNodeB?.value) === 66,
    `journal=${JSON.stringify(switchJournal.slice(0, 1))} runRecipe=${startB?.data?.run?.recipeId} A=${sNodeA?.value} B=${sNodeB?.value}`)
  evidence.switch = {
    recipeB: recipeB?.id, runB: startB?.data?.run?.id, trialResponse: switchText, journal: switchJournal.slice(0, 2),
  }

  // ── 产线配方管理权(kind='line-recipe'):真实 Agent 建/改/回退全线配方 + 下发按 dcw 收窄 ──
  const mgrCh = await makeChannel('验收-配方管理员', writeLine.id,
    '你是产线配方管理员:可查看/新建/修改/回退本产线全部配方;参数下发只允许你绑定的数控点位。严格按任务步骤执行,不复测、不等待、不固化。', 'auto',
    ['my_industrial_nodes', 'line_context', 'recipe_create', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'complete_task', 'report_progress'])
  const mgrLead = mgrCh.lead
  ok('R10', '配方管理员频道创建(omp/selected/工具面含管理工具)', Boolean(mgrCh.channelId) && mgrCh.toolsSaved === 200, `channel=${mgrCh.channelId} tools=${mgrCh.toolsSaved}`)
  const mgrLineGrant = await bindAuto(mgrLead.id, writeLine.id, 'line-recipe')
  const mgrDcwBind = await bindAuto(mgrLead.id, dcwA.id, 'dcw')
  ok('R10b', '管理权 + 单点位 dcw 绑定落库', mgrLineGrant.status === 200 && mgrDcwBind.status === 200,
    `grant=${mgrLineGrant?.data?.binding?.kind}:${mgrLineGrant?.data?.binding?.mode} dcw=${mgrDcwBind?.data?.binding?.kind}:${mgrDcwBind?.data?.binding?.mode}`)
  const tokMgr = agentTokenOf(mgrLead.id)

  // 下发收窄(对当时活动配方 writeRecipe,A/B 都是参数):未绑定节点拒,绑定点位放行
  const curNodes = await api('GET', '/api/workshop/dcw')
  const curA = (curNodes?.data?.nodes ?? []).find(n => n.id === dcwA.id)
  const trialUnbound = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: mgrLead.id, tool: 'recipe_trial',
    args: { line_id: writeLine.id, params: [{ node_id: dcwB.id, value: 62 }], hypothesis: '验收:管理权 Agent 未绑定该点位,应被收窄拒绝' },
  }, undefined, { 'x-aw-agent-token': tokMgr })
  const unboundText = String(trialUnbound?.data?.result?.text ?? trialUnbound?.data?.text ?? '')
  ok('R10c', '管理权 + dcw 绑定 → 未绑定节点下发被收窄拒', Boolean(trialUnbound?.data?.result?.isError ?? trialUnbound?.data?.isError) && /下发被收窄|只能覆盖这些点位/.test(unboundText), unboundText.slice(0, 300))
  const trialBound = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: mgrLead.id, tool: 'recipe_trial',
    args: { line_id: writeLine.id, params: [{ node_id: dcwA.id, value: Number(curA?.value ?? 52) + 2 }], hypothesis: '验收:绑定点位内下发放行' },
  }, undefined, { 'x-aw-agent-token': tokMgr })
  const boundText = String(trialBound?.data?.result?.text ?? trialBound?.data?.text ?? '')
  ok('R10d', '管理权 + dcw 绑定 → 绑定点位内 trial 放行(真实 Agent 身份)', !(trialBound?.data?.result?.isError ?? trialBound?.data?.isError) && /试验已整批下发/.test(boundText), boundText.slice(0, 300))

  // 真实 omp 任务:创建配方(用绑定的节点)。9B 模型可能自选 use_active_run 快照,
  // 断言按「任务窗口内本线新增的配方」判定(能力级),不绑死命名。
  const recipesBefore = (await api('GET', `/api/workshop/dcw/recipes`))?.data?.recipes ?? []
  const knownIds = new Set(recipesBefore.map(r => r.id))
  const mgrCreateTask = await submitTask(mgrCh.channelId, '验收-管理权-新建配方',
    '严格按三步执行,不要做别的:\n'
    + '1) 调用 my_industrial_nodes 查看你的授权(记下绑定的数控节点 id);\n'
    + `2) 调用 recipe_create:line_id="${writeLine.id}",name="验收-管理权配方",显式传 params=[{node_id:"<你绑定的节点id>",value:58}](不要使用 use_active_run/source_recipe_id/from_run_id),reason 写「验收:产线配方管理权新建配方」;\n`
    + '3) 立即调用 complete_task 提交 recipe_create 完整回执与新配方 id。\n'
    + '禁止其他任何工具。')
  const mgrCreateRun = await waitTask(mgrCreateTask.id, { timeoutMs: 10 * 60_000 })
  const recipesOnLine = (await api('GET', `/api/workshop/dcw/recipes`))?.data?.recipes ?? []
  const mgrRecipe = recipesOnLine.find(r => r.lineId === writeLine.id && !knownIds.has(r.id))
  ok('R10e', '真实 Agent 凭产线管理权新建配方成功(无单配方绑定,窗口内新增)', mgrCreateRun.task?.state === 'COMPLETED' && Boolean(mgrRecipe),
    `task=${mgrCreateRun.task?.state} recipe=${mgrRecipe?.id ?? '(未找到)'} deliverable=${deliverableOf(mgrCreateRun.task).slice(0, 200)}`)

  if (mgrRecipe) {
    // 管理权:切换产线到新配方(其参数接管 DCW),再由同一 Agent 修改+回退。
    // 新配方参数值可能是模型自选的快照值:以 v1 定义里 dcwA 的实际值为基线断言。
    const mgrV1 = ((await api('GET', `/api/workshop/dcw/recipes/${mgrRecipe.id}/versions`))?.data?.versions ?? [])[0]
    const baseA = Number((mgrV1?.params ?? []).find(p => p.nodeId === dcwA.id)?.value)
    const stopPrev = await api('POST', `/api/workshop/dcw/lines/${writeLine.id}/stop`, undefined, admin)
    const startM = await api('POST', `/api/workshop/dcw/lines/${writeLine.id}/start`, { recipeId: mgrRecipe.id }, admin)
    const afterStart = await api('GET', '/api/workshop/dcw')
    const mNodeA = (afterStart?.data?.nodes ?? []).find(n => n.id === dcwA.id)
    ok('R10f', '新配方开跑:管理权新建的配方接管 DCW(A=v1 定义值)', stopPrev.status === 200 && startM.status === 200 && Number.isFinite(baseA) && Number(mNodeA?.value) === baseA,
      `stop=${stopPrev.status} start=${startM.status} A=${mNodeA?.value} v1A=${baseA}`)
    const mgrEditTask = await submitTask(mgrCh.channelId, '验收-管理权-修改并回退',
      '严格按三步执行,不要做别的:\n'
      + `1) 调用 recipe_update:recipe_id="${mgrRecipe.id}",params=[{node_id:"${dcwA.id}",value:56}],reason 写「验收:管理权直接修改全线配方」;\n`
      + `2) 调用 recipe_rollback:recipe_id="${mgrRecipe.id}",version=1,reason 写「验收:管理权回退到 v1(仅定义)」;\n`
      + '3) 立即调用 complete_task 提交两步回执原文。\n'
      + '禁止其他任何工具。')
    const mgrEditRun = await waitTask(mgrEditTask.id, { timeoutMs: 10 * 60_000 })
    const mgrVersions = (await api('GET', `/api/workshop/dcw/recipes/${mgrRecipe.id}/versions`))?.data?.versions ?? []
    const v2Row = mgrVersions.find(v => v.version === 2)
    const lastRow = mgrVersions[mgrVersions.length - 1]
    ok('R10g', '同一 Agent 修改配方(update v2=56)成功', mgrVersions.some(v => v.version === 2),
      `task=${mgrEditRun.task?.state} versions=${mgrVersions.map(v => `${v.version}:${(v.params ?? []).map(p => p.value).join('/')}`).join(',')}`)
    ok('R10h', '同一 Agent 回退配方(生成新版本,参数回到 v1)', Number(lastRow?.version) >= 3
    && Array.isArray(lastRow?.params) && Number.isFinite(baseA) && lastRow.params.some(p => p.nodeId === dcwA.id && p.value === baseA)
    && Array.isArray(v2Row?.params) && v2Row.params.some(p => p.nodeId === dcwA.id && p.value !== baseA),
    `versions=${mgrVersions.map(v => `${v.version}:${(v.params ?? []).map(p => p.value).join('/')}`).join(',')}`)
    // 收回管理权 → 版本操作立即被拒(dcw 点位绑定不授予版本权)
    const mgrGrantId = mgrLineGrant?.data?.binding?.id
    await api('DELETE', `/api/workshop/agent-tools/bindings/${mgrGrantId}`, undefined, admin)
    const updAfterRevoke = await api('POST', '/api/workshop/agent-tools/invoke', {
      agentId: mgrLead.id, tool: 'recipe_update',
      args: { recipe_id: mgrRecipe.id, params: [{ node_id: dcwA.id, value: 55 }], reason: '验收:收回管理权后应拒绝' },
    }, undefined, { 'x-aw-agent-token': tokMgr })
    const revokeText = String(updAfterRevoke?.data?.result?.text ?? updAfterRevoke?.data?.text ?? '')
    ok('R10i', '收回产线管理权后 recipe_update → 拒绝(需配方级授权)',
      Boolean(updAfterRevoke?.data?.result?.isError ?? updAfterRevoke?.data?.isError) && /配方级授权|版本操作|配方管理权/.test(revokeText), revokeText.slice(0, 300))
    evidence.lineManager = {
      channel: mgrCh.channelId, agent: mgrLead.id, lineGrant: mgrGrantId, dcw: dcwA.id,
      recipe: mgrRecipe.id, versions: mgrVersions.map(v => ({ version: v.version, values: (v.params ?? []).map(p => p.value) })),
      scopedTrial: { unbound: unboundText.slice(0, 200), bound: boundText.slice(0, 200) },
      createDeliverable: deliverableOf(mgrCreateRun.task), editDeliverable: deliverableOf(mgrEditRun.task),
      toolCallsCreate: toolCallsOf(mgrCreateRun.task), toolCallsEdit: toolCallsOf(mgrEditRun.task),
    }
  }

  // ── IDD 集成(仅检查,不启动分析) ──
  const pluginsR = await api('GET', '/api/workshop/plugins')
  const pluginRows = pluginsR?.data?.plugins ?? pluginsR?.plugins ?? pluginsR?.data ?? []
  const wanted = ['idd-closedloop-bridge', 'diag-bridge', 'rag-bridge']
  const pluginState = wanted.map((name) => {
    const row = Array.isArray(pluginRows) ? pluginRows.find(p => p.name === name) : pluginRows?.[name]
    return { name, enabled: Boolean(row?.enabled), error: row?.error ?? row?.lastError ?? null }
  })
  const toolsR = await api('GET', '/api/workshop/tools')
  const toolRows = toolsR?.data?.tools ?? toolsR?.tools ?? toolsR?.data ?? []
  const requiredTools = ['diag_run', 'diag_status', 'kb_agent']
  const toolState = requiredTools.map((name) => {
    const row = Array.isArray(toolRows) ? toolRows.find(t => t.name === name) : null
    return { name, registered: Boolean(row), available: row ? row.available !== false : false }
  })
  let iddHealth = null
  try {
    const r = await fetch('http://127.0.0.1:3210/health', { signal: AbortSignal.timeout(3000) })
    iddHealth = { status: r.status, ok: r.ok }
  }
  catch (err) {
    iddHealth = { status: 0, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  ok('R7', 'IDD 集成:三插件在位且启用、诊断/知识工具已注册', pluginState.every(p => p.enabled) && toolState.filter(t => t.available).length >= 2,
    JSON.stringify({ pluginState, toolState }))
  ok('R7b', 'IDD 后端可达(不启动任何分析)', Boolean(iddHealth?.ok), JSON.stringify(iddHealth))
  evidence.idd = { plugins: pluginState, tools: toolState, backendHealth: iddHealth, analysisStarted: false, note: '仅检查集成面,未调用 diag_run/未启动分析(token 缺失时诊断调用会 401,属配置缺口)' }

  evidence.assertions = results
}
catch (err) {
  ok('FATAL', '验收未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
  evidence.assertions = results
}
finally {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const passed = results.filter(r => r.pass).length
  const total = results.length
  evidence.summary = { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(evidence, null, 2))
  for (const [mode, task] of Object.entries(evidence.tasks)) {
    writeFileSync(join(EVIDENCE_DIR, `${mode}-task.json`), JSON.stringify(task, null, 2))
  }
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${join(EVIDENCE_DIR, 'report.json')}`)
  process.exit(passed === total ? 0 : 1)
}
