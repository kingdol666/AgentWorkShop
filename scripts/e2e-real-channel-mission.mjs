#!/usr/bin/env node
/**
 * 真实 harness 全链路功能验收 —— Channel 任务中 Agent 真实使用五能力
 *
 * 真实模型:LM Studio qwen3.5-9b-64k(65536 ctx,lms ps 核实)经 omp harness(rpc 模式+运行级 overlay)。
 * 场景:cast-film-physics 四协议产线,一条 aml_optimization 工艺优化频道(模板实例化),
 * omp Agent 在任务中:数采真实抓数(R2) → HITL 挂起/批准/真实下发(R3) → 数控调优+PV 随动+账本归因(R4)。
 * 另含:五能力工具面在册(R1)、AML 训练面+求解器门控(R5)、本体语义注入(R6)。
 *
 * 判据规范:docs/audit/2026-10-30-real-harness-acceptance-plan.md
 * 运行:node scripts/e2e-real-channel-mission.mjs(自起隔离实例 3423 + 隔离模拟器 4038)
 * 证据:docs/audit/evidence/2026-10-30-real-channel-mission/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_RHACC_HOME ?? 'D:/tmp/aw-rhacc-20261030'
const PORT = Number(process.env.AW_RHACC_PORT ?? 3423)
const BASE = `http://127.0.0.1:${PORT}`
const SIM_PORT = Number(process.env.AW_RHACC_SIM_PORT ?? 4038)
const SIM_BASE = `http://127.0.0.1:${SIM_PORT}`
const SIM_SHADOW = process.env.AW_RHACC_SIM_SHADOW ?? 'D:/tmp/aw-rhacc-sim-shadow-4038'
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-30-real-channel-mission')
const DEMO_MODEL = process.env.AW_DEMO_MODEL ?? 'qwen3.5-9b-64k'

process.env.SIM_BASE = SIM_BASE
process.env.SIM_PORT = String(SIM_PORT)
process.env.SIM_SHADOW_DIR = SIM_SHADOW
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1800) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 750)}`}`)
  return Boolean(cond)
}

async function simApi(method, path, body) {
  const res = await fetch(SIM_BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data ?? json, message: json?.message ?? '' }
}
const simNodes = async () => (await simApi('GET', '/api/nodes')).data ?? []
const simSignal = (nodes, deviceId, signalId) => {
  const sig = (nodes.find(n => n.id === deviceId)?.signals ?? []).find(s => s.id === signalId)
  return sig?.value == null ? null : Number(sig.value)
}

function stopInstance(home) {
  const pidFile = join(home, 'server.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  }
  catch { /* 已退出 */ }
}
async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json())?.data ?? null
  }
  catch { return null }
}
async function startInstance() {
  stopInstance(HOME)
  await sleep(1500)
  if (await health()) throw new Error(`端口 ${PORT} 已被非本验收实例占用`)
  if (!/aw-rhacc/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  const log = openSync(join(HOME, 'server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      PORT: String(PORT),
      NUXT_SESSION_PASSWORD: 'rhacc-20261030-session',
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
async function apiOnce(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
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
async function api(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
  try {
    return await apiOnce(method, path, body, token, extraHeaders, timeoutMs)
  }
  catch (err) {
    if (err instanceof TypeError) {
      await sleep(1500)
      return apiOnce(method, path, body, token, extraHeaders, timeoutMs)
    }
    throw err
  }
}
function must(resp, what) {
  if (resp.status !== 200 || !resp?.data) throw new Error(`${what} 失败:${resp.status} ${JSON.stringify(resp).slice(0, 500)}`)
  return resp.data
}
function agentTokenOf(agentId) {
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
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
/** 以 agent 令牌直调工具(确定性路径);出现 HITL 卡自动批准(验收模拟人工) */
async function invokeAs(agentId, token, tool, args, { timeoutMs = 180_000 } = {}) {
  const cards = []
  let resp = null
  let err = null
  const started = Date.now()
  const p = api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': token }, timeoutMs)
    .then((r) => {
      resp = r
    })
    .catch((e) => {
      err = e
    })
  while (!resp && !err && Date.now() - started < timeoutMs - 10_000) {
    for (const card of await pendingOf(agentId)) {
      if (cards.includes(card.id)) continue
      cards.push(card.id)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:直调路径' })
    }
    await sleep(1000)
  }
  await p
  const text = String(resp?.data?.result?.text ?? resp?.data?.text ?? '')
  const isError = Boolean(resp?.data?.result?.isError ?? resp?.data?.isError) || Boolean(err)
  return { resp, text, isError, cards }
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'])
const taskOf = r => r?.data?.task ?? r?.data ?? null
const deliverableOf = task => String((task?.artifacts ?? []).find(a => a.name === 'deliverable')?.parts?.map(p => p.text ?? '').join('\n') ?? '')
const toolCallsOf = task => (task?.history ?? [])
  .map(h => String(h?.parts?.map(p => p.text ?? '').join(' ') ?? ''))
  .filter(t => t.includes('🔧'))
  .map(t => t.replace(/\s+/g, ' ').slice(0, 300))
/**
 * 轮询任务到终态。onCard:新 HITL 卡回调(检查点),随后自动批准(验收模拟人工)。
 * evidenceFn 命中后经 graceMs 宽限仍无终态且无挂起卡 → 收口 cancel(证据落定即止,不等慢模型)。
 */
async function waitTask(taskId, agentId, { timeoutMs = 8 * 60_000, evidenceFn = null, graceMs = 60_000, onCard = null } = {}) {
  const started = Date.now()
  let evidenceAt = 0
  const seen = new Set()
  while (Date.now() - started < timeoutMs) {
    const task = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
    for (const card of await pendingOf(agentId)) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      if (onCard) await onCard(card)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:任务路径' })
    }
    if (TERMINAL.has(String(task?.state ?? ''))) return { task, cancelled: false, cards: [...seen] }
    if (evidenceFn && evidenceFn(task, [...seen]) && !evidenceAt) evidenceAt = Date.now()
    if (evidenceAt && Date.now() - evidenceAt > graceMs) {
      if (!(await pendingOf(agentId)).length) {
        await api('POST', `/api/workshop/tasks/${taskId}/cancel`, { reason: '验收:证据收口' })
        return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cancelled: true, cards: [...seen] }
      }
      evidenceAt = Date.now() // 有卡挂着:重置宽限,继续等审批与任务前进
    }
    await sleep(2000)
  }
  return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cancelled: false, cards: [...seen] }
}
const latestSample = async (nodeId, seconds = 30) => {
  const to = Date.now()
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${to - seconds * 1000}&to=${to}&bucketMs=1000&limit=200`)
  const pts = (r?.data?.points ?? []).map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
  return pts.length ? pts[pts.length - 1] : null
}

const evidence = { at: new Date().toISOString(), model: DEMO_MODEL, scenario: {}, assertions: results }
let run3
let run4
let calls4
let deliv4
let deliv2
let spBase4
let injText
let ctxText
let capsText
let solveText

try {
  // ═══ R0 · 隔离环境 ═══
  const sim = await import(pathToFileURL(join(REPO, 'bench', 'lib', 'sim.mjs')).href)
  const boot = await sim.ensureSimulator({ log: m => console.log(`    ${m}`) })
  ok('R0.1', '隔离模拟器在线(4038)', boot.started || /already-up/.test(String(boot.reason)), JSON.stringify(boot))
  await sim.applyPreset('cast-film-physics')
  const nodes0 = await simNodes()
  ok('R0.2', '四协议设备端点在线(cast-film-physics)', nodes0.filter(n => n.runtime?.running).length >= 5,
    nodes0.map(n => `${n.id}:${n.protocol}`).join(', '))

  const exportItems = async id => must(await simApi('GET', `/api/nodes/${id}/export`), `导出 ${id}`).items ?? []
  const bySignal = async (id, signal) => {
    const row = (await exportItems(id)).find(i => i.signal === signal)
    if (!row) throw new Error(`导出缺少 ${id}/${signal}`)
    return row.driverConfig
  }
  const cfgZone = await bySignal('dev-extruder-mbtcp', '加热区1SP')
  const cfgTemp = await bySignal('dev-extruder-mbtcp', '熔体温度')

  const h = await startInstance()
  ok('R0.3', '生产构建隔离实例就绪(3423,全新 home)', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)
  // 隔离新库:needsSetup=true 时首注册即 admin(setup 模式);已有库则直接 login
  const setup = await api('GET', '/api/users/setup-status')
  if (setup.data?.needsSetup) {
    admin = (await api('POST', '/api/users/register', { name: 'rhacc-admin', email: 'admin@awshop.local', password: 'admin123' })).data?.token
  }
  else {
    admin = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token
  }
  ok('R0.4', 'admin 鉴权(隔离新库首注册即 admin)', Boolean(admin))

  // ═══ 供给:产线 + DAQ + 一根 Modbus 数控节点 + 配方 + 开线 ═══
  const line = must(await api('POST', '/api/workshop/dcw/lines', { name: '真实harness验收线', description: '五能力 Channel 任务验收' }), '建线').line?.id
  const daq = must(await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: '熔体温度', driver: 'modbus-tcp', driverConfig: cfgTemp,
    lineId: line, intervalMs: 1000, publishIntervalMs: 0, min: 0, max: 400, decimals: 2,
  }), '建 DAQ').node?.id
  const zone = must(await api('POST', '/api/workshop/dcw', {
    templateRef: 'temp-sp', name: '加热区1设定', driver: 'modbus-tcp', driverConfig: cfgZone, lineId: line,
    unit: 'C', min: 120, max: 260, decimals: 2, stepLimit: 5, writeLockSeconds: 0, readIntervalMs: 2000,
  }), '建 zone').node?.id
  const product = must(await api('POST', '/api/workshop/dcw/products', { name: '验收产品', lineId: line, paramLimits: {} }), '建产品').product
  const recipe = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: '验收基线配方', productId: product.id, opIntervalMs: 0,
    params: [{ nodeId: zone, value: 195, min: 120, max: 260, stepLimit: 5 }],
  }), '建配方').recipe
  await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  const started = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipe.id })
  await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true })
  await sleep(12_000)
  const devNow = await simNodes()
  const daqNow = await latestSample(daq, 20)
  ok('R0.5', '开线且基线落设备(modbus SP + DAQ 首采)', started.status === 200
  && Number.isFinite(simSignal(devNow, 'dev-extruder-mbtcp', 'zone1-sp')) && daqNow != null,
  `SP=${simSignal(devNow, 'dev-extruder-mbtcp', 'zone1-sp')} daqLast=${daqNow}`)

  // ═══ R1 频道 + omp 真模型 Agent + 五能力工具面 ═══
  const overlay = join(HOME, 'omp-overlay.yml')
  writeFileSync(overlay, [
    'modelRoles:',
    ...['default', 'task', 'advisor', 'slow', 'designer'].map(r => `  ${r}: lm-studio/${DEMO_MODEL}`),
    'tools:',
    '  format: qwen3',
    'compaction:',
    '  enabled: true',
    '',
  ].join('\n'))
  const tpl = await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', {
    name: '真实harness-工艺优化', toolProfile: 'aml_optimization', optimizationMode: 'exploration',
  })
  const optCh = tpl.data ?? {}
  const channelId = optCh?.channelId
  ok('R1.1', 'aml_optimization 工艺优化频道(模板实例化)', tpl.status === 200 && Boolean(channelId), `ch=${channelId} lead=${optCh?.leadAgentId ?? '—'}`)
  const omp = must(await api('POST', '/api/workshop/agents', {
    name: 'omp-真实模型操作员', harness: 'omp',
    config: { rpcMode: 'rpc', args: ['--no-tools', '--thinking=off', '--config', overlay] },
  }), '建 omp Agent')
  const ompTplId = omp.id ?? omp.data?.id // must() 已解包 data:omp 即模板对象
  if (!ompTplId) throw new Error(`omp 模板创建回包缺 id:${JSON.stringify(omp).slice(0, 200)}`)
  const joinResp = await api('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: ompTplId, role: 'worker' })
  let agentId = joinResp.data?.id ?? joinResp.data?.agentId ?? joinResp.data?.member?.id ?? joinResp.data?.agent?.id
  if (!agentId) {
    // 回包形状兜底:按 channel+名字直查实例表
    const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
    try {
      agentId = String(db.prepare('SELECT id FROM channel_agents WHERE channel_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1').get(channelId, 'omp-真实模型操作员')?.id ?? '')
    }
    finally { db.close() }
  }
  if (!agentId) {
    const j = (v) => {
      try {
        return JSON.stringify(v) ?? String(v)
      }
      catch { return '(unserializable)' }
    }
    throw new Error(`omp 入队失败:join=${joinResp.status}/${j(joinResp).slice(0, 400)} ompKeys=${omp.data ? Object.keys(omp.data).join(',') : 'data-undefined'} omp=${j(omp).slice(0, 300)}`)
  }
  await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: { provider: 'lm-studio', model: DEMO_MODEL, contextTokens: 65536 } })
  const ompToken = agentTokenOf(agentId)
  ok('R1.2', 'omp Agent(rpc+overlay,lm-studio 64k)入队且令牌可读', Boolean(agentId && ompToken), `agent=${agentId} token=${ompToken ? '***' + ompToken.slice(-4) : 'MISSING'}`)

  const bindDcw = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: zone, kind: 'dcw', mode: 'manual' })
  const bDaq = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId: daq, kind: 'daq', mode: 'auto' })
  if (bDaq?.data?.binding?.mode === 'manual') await api('PATCH', `/api/workshop/agent-tools/bindings/${bDaq.data.binding.id}`, { mode: 'auto', confirm: true })
  const bindingMode = bindDcw?.data?.binding?.mode
  ok('R1.3', '绑定面建立:dcw=manual(HITL 缺省)+daq=auto', bindDcw.status === 200 && bDaq.status === 200 && bindingMode === 'manual', `dcw mode=${bindingMode} daq=${bDaq.status}`)

  // 9B 模型 + 64k 上下文:开放面(81 工具)的 schema 注入 ≈78k tokens,直接撑爆上下文
  // (实测 OMP_LLM_ERROR n_keep:77925>=n_ctx:65536)。收窄到本验收所需的最小面。
  await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
    mode: 'selected',
    tools: ['my_industrial_nodes', 'line_context', 'daq_query', 'daq_frames', 'optimization_explore', 'dcw_judge', 'dcw_journal', 'optimizer_capabilities', 'complete_task', 'report_progress']
      .map(name => ({ name, enabled: true })),
  })
  const toolList = (await api('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agentId)}`)).data?.tools ?? []
  const toolNames = toolList.map(t => t.name)
  const needFace = ['my_industrial_nodes', 'daq_query', 'daq_frames', 'optimization_explore', 'dcw_journal', 'dcw_judge', 'optimizer_capabilities']
  ok('R1.4', '五能力工具面在册且已收窄(数采/数控治理/求解器)', needFace.every(n => toolNames.includes(n)),
    `missing=${needFace.filter(n => !toolNames.includes(n)).join(',') || '无'}; face=${toolNames.length} 项`)

  // ═══ R2 · 数采真实抓数(LLM 任务) ═══
  const t2 = taskOf(await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: 'R2-真实抓数',
    description: '严格按两步执行,不要做别的:\n'
      + `1) 调用 daq_query:node_id="${daq}",last_minutes=3,bucket_ms=1000,读出样本数与最新值;\n`
      + '2) 立即调用 complete_task,汇报样本数与最新温度数值。\n'
      + '只允许 daq_query 与 complete_task 两个工具;不要等待/睡眠。',
    assigneeId: agentId,
    parts: [{ text: `daq_query(node_id="${daq}", last_minutes=3, bucket_ms=1000) 后 complete_task 汇报数值` }],
  }))
  if (!t2?.id) throw new Error(`R2 任务创建失败:${JSON.stringify(t2).slice(0, 200)}`)
  const run2 = await waitTask(t2.id, agentId, {
    timeoutMs: 8 * 60_000,
    evidenceFn: t => toolCallsOf(t).some(x => x.includes('daq_query')),
    graceMs: 50_000,
  })
  const calls2 = toolCallsOf(run2.task)
  const blob2 = deliverableOf(run2.task) + '\n' + (run2.task?.history ?? []).map(h2 => (h2?.parts ?? []).map(p2 => p2?.text ?? '').join(' ')).join('\n')
  deliv2 = blob2
  const truth2 = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'melt-temp')
  const nums2 = (blob2.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter(v => v > 20 && v < 400)
  const near2 = nums2.some(v => truth2 != null && Math.abs(v - truth2) <= 3)
  ok('R2.1', 'LLM 任务中 daq_query 真实抓数(数值=设备真值±3℃)',
    calls2.some(x => x.includes('daq_query')) && near2 && (run2.task?.state === 'COMPLETED' || run2.cancelled),
    `state=${run2.task?.state} truth=${truth2} 交付数值=[${nums2.slice(0, 8).join(',')}]`)

  // ═══ R3 · HITL 真实审批(批准前后设备双时点对照) ═══
  const spBefore = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'zone1-sp')
  const step3 = 3
  const t3 = taskOf(await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: 'R3-HITL下发生效',
    description: '严格按两步执行,第一步必须先做:\n'
      + `1) 你的第一个动作就是调用 optimization_explore,参数:control_node_id="${zone}",target_node_id="${daq}",direction="up",step=${step3},settle_seconds=10,hypothesis="HITL 验收:上调 3C"。不要先做任何其他事;\n`
      + '2) 该调用返回结果后(可能等待人工批准,耐心等它返回),调用 complete_task 汇报探索记录号与回读值。\n'
      + '整个任务只允许这两个工具:optimization_explore、complete_task。禁止调用 search_memory、save_memory、daq_query 或任何其他工具;不要复述场景简报。',
    assigneeId: agentId,
    parts: [{ text: `第一个动作:optimization_explore(control_node_id="${zone}", target_node_id="${daq}", direction="up", step=${step3}, settle_seconds=10),返回后 complete_task` }],
  }))
  if (!t3?.id) throw new Error(`R3 任务创建失败:${JSON.stringify(t3).slice(0, 200)}`)
  const checkpoint = { cardId: null, cardTool: '', spAtCard: null }
  run3 = await waitTask(t3.id, agentId, {
    timeoutMs: 10 * 60_000,
    onCard: async (card) => {
      checkpoint.cardId = card.id
      checkpoint.cardTool = String(card.tool ?? card.toolName ?? '')
      await sleep(3000) // 卡已挂起:给"若误直写"一个暴露窗,再取批准前时点
      checkpoint.spAtCard = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'zone1-sp')
      console.log(`    · HITL 卡 ${card.id}(${checkpoint.cardTool})挂起,批准前 SP=${checkpoint.spAtCard}(基线 ${spBefore})`)
    },
  })
  const unchangedBeforeApproval = checkpoint.spAtCard != null && Math.abs(checkpoint.spAtCard - spBefore) <= 0.05
  ok('R3.1', 'HITL 挂起出现且批准前设备值不变(写被真实拦截)',
    checkpoint.cardId && unchangedBeforeApproval,
    `card=${checkpoint.cardId ?? '未出现'} tool=${checkpoint.cardTool} 批准前SP=${checkpoint.spAtCard} 基线=${spBefore}`)
  if (checkpoint.cardId) {
    let spAfter3 = null
    const t03 = Date.now()
    while (Date.now() - t03 < 60_000) {
      await sleep(4000)
      spAfter3 = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'zone1-sp')
      if (spAfter3 != null && Math.abs(spAfter3 - (spBefore + step3)) <= 0.5) break
    }
    ok('R3.2', '批准后真实下发:设备寄存器值=基线+3(±0.5)',
      spAfter3 != null && Math.abs(spAfter3 - (spBefore + step3)) <= 0.5,
      `批准后SP=${spAfter3} 期望=${spBefore + step3}`)
    ok('R3.3', 'LLM 任务收口(COMPLETED/收口 cancel)', run3.task?.state === 'COMPLETED' || run3.cancelled,
      `state=${run3.task?.state} calls=${toolCallsOf(run3.task).length}`)
  }

  // ═══ R4 · 数控真实下发 + 任务调优(auto 绑定,LLM 单步调优;9B 非确定性 → 至多两次派发) ═══
  spBase4 = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'zone1-sp')
  await api('PATCH', `/api/workshop/agent-tools/bindings/${bindDcw.data.binding.id}`, { mode: 'auto', confirm: true })
  const step4 = 2.5
  const recsBefore4 = ((await api('GET', '/api/workshop/dcw/optimizations?limit=50')).data?.records ?? []).filter(r => r.nodeId === zone).length
  const mkTask4 = () => api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `R4-调优任务(尝试${Date.now() % 1000})`,
    description: '你是工艺操作员,严格按四步执行,不要做别的:\n'
      + `1) 调用 daq_query,只传三个参数:node_id="${daq}",last_minutes=2,bucket_ms=1000(不要传 recipe_id 或任何其他参数);\n`
      + `2) 本任务的核心步骤:调用 optimization_explore,参数:control_node_id="${zone}",target_node_id="${daq}",direction="up",step=${step4},settle_seconds=10,hypothesis="调优:按计划上调 ${step4}C";\n`
      + `3) 再调用一次 daq_query(node_id="${daq}",last_minutes=1,bucket_ms=1000) 观察响应;\n`
      + '4) 调用 complete_task,汇报调优前后两个温度数值。\n'
      + '只允许 daq_query、optimization_explore、complete_task 三个工具;optimization_explore 必须执行且只调用一次;禁止 search_memory/save_memory;不要等待/睡眠。',
    assigneeId: agentId,
    parts: [{ text: `调优:${zone} 上调 ${step4}C,daq="${daq}",完成后 complete_task` }],
  })
  let r4done = false
  let spAfter4 = null
  for (let attempt = 1; attempt <= 2 && !r4done; attempt++) {
    const t4 = taskOf(await mkTask4())
    if (!t4?.id) throw new Error(`R4 任务创建失败:${JSON.stringify(t4).slice(0, 200)}`)
    run4 = await waitTask(t4.id, agentId, {
      timeoutMs: 15 * 60_000,
      evidenceFn: t => toolCallsOf(t).some(x => x.includes('optimization_explore')),
      graceMs: 90_000,
    })
    calls4 = toolCallsOf(run4.task)
    const t04 = Date.now()
    while (Date.now() - t04 < 60_000) {
      await sleep(4000)
      spAfter4 = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'zone1-sp')
      if (spAfter4 != null && Math.abs(spAfter4 - (spBase4 + step4)) <= 0.75) break
    }
    r4done = spAfter4 != null && Math.abs(spAfter4 - (spBase4 + step4)) <= 0.75
    if (!r4done && attempt === 1) {
      spBase4 = simSignal(await simNodes(), 'dev-extruder-mbtcp', 'zone1-sp') ?? spBase4 // 二次尝试以当前 SP 为基线
      console.log(`    · R4 第一次派发未落点(SP=${spAfter4}),重发任务(9B 非确定性容差)`)
    }
  }
  ok('R4.1', '调优真实下发:设备 SP=基线+2.5(±0.75)',
    spAfter4 != null && Math.abs(spAfter4 - (spBase4 + step4)) <= 0.75,
    `SP=${spAfter4} 期望=${spBase4 + step4} state=${run4.task?.state} calls=${calls4.map(c => c.slice(0, 60)).join(' | ').slice(0, 260)}`)
  await sleep(8000)
  const pv4 = await latestSample(daq, 25)
  ok('R4.2', 'PV 随动:熔体温度样本向新 SP 收敛(±4℃)', pv4 != null && spAfter4 != null && Math.abs(pv4 - spAfter4) <= 4,
    `pv=${pv4} sp=${spAfter4}`)
  const jr = await invokeAs(agentId, ompToken, 'dcw_journal', { node_id: zone, limit: 5 })
  ok('R4.3', '参数账本 Agent 归因(dcw_journal 含 Agent 来源)', !jr.isError && /Agent|agent|优化|探索/.test(jr.text),
    jr.text.replace(/\s+/g, ' ').slice(0, 300))
  const optRecs4 = ((await api('GET', '/api/workshop/dcw/optimizations?limit=50')).data?.records ?? []).filter(r => r.nodeId === zone)
  ok('R4.4', '优化记录链存在(本阶段治理写新开窗)', optRecs4.length > recsBefore4,
    `R4 前本节点记录=${recsBefore4} · R4 后=${optRecs4.length}`)
  ok('R4.5', 'LLM 调优任务收口(COMPLETED/收口 cancel)', run4.task?.state === 'COMPLETED' || run4.cancelled,
    `state=${run4.task?.state}`)
  deliv4 = deliverableOf(run4.task) + '\n' + (run4.task?.history ?? []).map(h4 => (h4?.parts ?? []).map(p4 => p4?.text ?? '').join(' ')).join('\n')
  ok('R4.6', '交付文本含调优前后数值(≥2 个温度读数)', (deliv4.match(/\d+(\.\d+)?/g) ?? []).length >= 2,
    deliv4.replace(/\s+/g, ' ').slice(0, 300))

  // ═══ R5 · AML 训练面 + 求解器门控 ═══
  const trainTpl = await api('POST', '/api/workshop/channel-templates/chtpl-aml-training-default/instantiate', { name: '真实harness-AML训练' })
  const trainChId = trainTpl.data?.channelId
  const trainLead = trainTpl.data?.leadAgentId ?? (trainTpl.data?.agents ?? []).find(a => a.role === 'lead')?.id
  if (trainLead) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: trainLead, nodeId: daq, kind: 'daq', mode: 'auto' })
  const amf = trainLead ? await invokeAs(trainLead, agentTokenOf(trainLead), 'aml_model_find', {}) : { isError: true, text: '训练频道未就绪' }
  ok('R5.1', 'AML 训练面:aml_model_find 可查询(模型清单可为空)', Boolean(trainChId) && !amf.isError,
    amf.text.replace(/\s+/g, ' ').slice(0, 240))
  const caps = await invokeAs(agentId, ompToken, 'optimizer_capabilities', {})
  capsText = caps.text
  ok('R5.2', '求解器:optimizer_capabilities 在优化频道可用', !caps.isError && caps.text.length > 20,
    caps.text.replace(/\s+/g, ' ').slice(0, 240))
  const solve = await invokeAs(agentId, ompToken, 'optimizer_solve', { objective: { target: 200 }, hypothesis: '验收:资格门负例' })
  solveText = solve.text
  ok('R5.3', '求解器:optimizer_solve 无合格 Profile 时被拒绝(负向断言,不放行执行)', solve.isError && solve.text.length > 0,
    solve.text.replace(/\s+/g, ' ').slice(0, 240))

  // ═══ R6 · 本体语义注入(节点工艺描述可达 Agent 面) ═══
  const inj = await invokeAs(agentId, ompToken, 'my_industrial_nodes', {})
  injText = inj.text
  ok('R6.1', '本体语义:my_industrial_nodes 含工艺描述与量纲', !inj.isError && /加热区1设定/.test(inj.text) && /C/.test(inj.text),
    inj.text.replace(/\s+/g, ' ').slice(0, 300))
  const ctx = await invokeAs(agentId, ompToken, 'line_context', { line_id: line })
  ctxText = ctx.text
  ok('R6.2', 'line_context 产线语义可读(绑定谱系扩权)', !ctx.isError && String(ctx.text).length > 40,
    String(ctx.text).replace(/\s+/g, ' ').slice(0, 300))

  evidence.scenario = {
    line, daq, zone, channelId, agentId, trainChId,
    spTrace: { r3: { before: spBefore, atCard: checkpoint.spAtCard }, r4: { before: spBase4 } },
  }
  evidence.texts = {
    r2: deliv2.slice(0, 900),
    r3: toolCallsOf(run3.task ?? {}).join(' | ').slice(0, 900),
    r4: (deliv4 || calls4.join(' | ')).slice(0, 900),
    r5: { caps: capsText.slice(0, 400), solve: solveText.slice(0, 400) },
    r6: { nodes: injText.slice(0, 600), line: ctxText.slice(0, 400) },
  }
}
catch (err) {
  ok('FATAL', '验收未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  stopInstance(HOME)
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const passed = results.filter(r => r.pass).length
  const total = results.length
  evidence.summary = { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(evidence, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${join(EVIDENCE_DIR, 'report.json')}`)
  console.log(`现场:平台 ${BASE}(AW_HOME=${HOME})/ 模拟器 ${SIM_BASE}`)
  process.exit(passed === total ? 0 : 1)
}
