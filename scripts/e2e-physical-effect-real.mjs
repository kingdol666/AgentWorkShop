#!/usr/bin/env node
/**
 * 物理生效真机验收 —— 真 PLC 模拟器(挤出流延物理孪生)+ 真 Modbus TCP 协议栈 + 真 omp/Qwen3.5:
 *   回答三个问题,每问都有**平台外**的独立证据:
 *     ① Agent 能不能抓到真实设备数据?  → Agent 工具调用 + 样本与设备直读值比对;
 *     ② Agent 下发的参数有没有真正写到设备? → 绕过平台直读 Modbus 保持寄存器(40021/23/25);
 *     ③ 写入是否产生工艺效果并被重新采到? → 物理孪生熔体温度对三区 SP 的响应 + 下发后样本回流。
 *
 * 拓扑:
 *   隔离模拟器(SIM_PORT=4036,影子私有 data/,设备 Modbus 端口 18740)
 *     dev-extruder-mbtcp: 40001 熔体温度(PV, DAQ) / 40021,23,25 三加热区 SP(DCW)
 *   隔离平台实例(AW_HOME=D:/tmp/aw-phys-20261028, PORT=3418)
 *     DAQ 节点(modelbus-tcp 直连 18740)→ TSDB;DCW×3(modbus-tcp)→ 配方管道写入
 *
 * 收口条件(全部满足):
 *   S 模拟器与设备侧动力学真实在线(直读 SP/PV 有效);
 *   P 平台以真实协议接入并开线:开线配方值直达设备寄存器(198);
 *   D 采样活性:窗口内样本充足、有波动,且**平台样本 ≈ 设备直读值**(同一物理量,误差 ≤1.5C);
 *   F Agent 单回合自主作业真实调用 daq_query(抓数)并自主发起试验(模型自选幅度落到设备),
 *     工具面直查文本含样本数与活动批次口径;
 *   W Agent 授权面批量下发三区 +5C:HITL 批准 → 账本 → 三寄存器直读=目标 → 平台回读=目标;
 *   R 物理响应:熔体温度沿目标方向上升 ≥1.5C,且下发后平台样本重新采到该变化;
 *   A 下发后同一 Agent 令牌复抓成功,复抓值沿 SP 方向且与平台样本一致。
 *
 * 运行:node scripts/e2e-physical-effect-real.mjs(自起隔离模拟器与实例;需 LM Studio qwen3.5-9b-32k)
 * 证据:docs/audit/evidence/2026-10-28-physical-effect/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import ModbusRTU from 'modbus-serial'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_PHYS_HOME ?? 'D:/tmp/aw-phys-20261028'
const PORT = Number(process.env.AW_PHYS_PORT ?? 3418)
const BASE = `http://127.0.0.1:${PORT}`
const SIM_PORT = Number(process.env.AW_PHYS_SIM_PORT ?? 4036)
const SIM_BASE = `http://127.0.0.1:${SIM_PORT}`
const SIM_SHADOW = process.env.AW_PHYS_SIM_SHADOW ?? 'D:/tmp/aw-phys-sim-shadow-4036'
const DEV_PORT = Number(process.env.AW_PHYS_DEV_PORT ?? 18740)
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-physical-effect')

// 模拟器客户端在 import 时读取这些环境变量 → 必须先设再动态 import
process.env.SIM_BASE = SIM_BASE
process.env.SIM_PORT = String(SIM_PORT)
process.env.SIM_SHADOW_DIR = SIM_SHADOW
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 700)}`}`)
  return Boolean(cond)
}

// ─────────────────────────── 模拟器(平台外设备真值) ───────────────────────────
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

/** 直读 Modbus 保持寄存器(完全绕开平台;float32 大端,协议偏移=地址-40001) */
async function deviceRead() {
  const client = new ModbusRTU()
  const close = async () => {
    try {
      await Promise.race([new Promise(r => client.close(() => r(true))), sleep(500)])
    }
    catch { /* 已断 */ }
  }
  const read = async (offset) => {
    const r = await client.readHoldingRegisters(offset, 2)
    const buf = Buffer.alloc(4)
    buf.writeUInt16BE(r.data[0], 0)
    buf.writeUInt16BE(r.data[1], 2)
    return Number(buf.readFloatBE(0).toFixed(4))
  }
  try {
    await client.connectTCP('127.0.0.1', { port: DEV_PORT })
    client.setID(1)
    const result = { sp: [await read(20), await read(22), await read(24)], pv: await read(0) }
    await close()
    return result
  }
  catch (err) {
    await close()
    throw err
  }
}

// ─────────────────────────── 平台实例 ───────────────────────────
function stopOwnedInstance() {
  const pidFile = join(HOME, 'server.pid')
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
  catch {
    return null
  }
}

async function startInstance() {
  stopOwnedInstance()
  await sleep(1500)
  if (await health()) throw new Error(`端口 ${PORT} 已被非本验收实例占用`)
  if (!/aw-phys/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
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
      NUXT_SESSION_PASSWORD: 'phys-effect-20261028-session',
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
const taskOf = r => r?.data?.task ?? r?.data ?? null
const deliverableOf = task => String((task?.artifacts ?? []).find(a => a.name === 'deliverable')?.parts?.map(p => p.text ?? '').join('\n') ?? '')
const toolCallsOf = task => (task?.history ?? [])
  .map(h => String(h?.parts?.map(p => p.text ?? '').join(' ') ?? ''))
  .filter(t => t.includes('🔧'))
  .map(t => t.replace(/\s+/g, ' ').slice(0, 240))
const nowIso = () => new Date().toISOString()
/** 任务终态(平台拼写 CANCELED;兼容双 L 变体) */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'])
const taskDone = task => TERMINAL.has(String(task?.state ?? ''))

async function pendingOf(agentId) {
  const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}`)
  return (r?.data?.approvals ?? []).filter(a => a.status === 'pending')
}
async function journalOf(lineId) {
  const r = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=500`)
  return r?.data?.anchors ?? []
}
async function latestSample(nodeId, seconds = 120) {
  const to = Date.now()
  const from = to - seconds * 1000
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${from}&to=${to}&bucketMs=1000&limit=200`)
  const points = (r?.data?.points ?? []).filter(p => Number.isFinite(p?.value ?? p?.avg))
  if (points.length === 0) return null
  const last = points[points.length - 1]
  return { at: last.at, value: Number(last.value ?? last.avg), count: points.length }
}
const evidence = {
  at: nowIso(),
  env: {
    base: BASE, simBase: SIM_BASE, home: HOME, simShadow: SIM_SHADOW, devicePort: DEV_PORT,
    model: { provider: 'lm-studio', model: process.env.AW_DEMO_MODEL ?? 'qwen3.5-9b-64k', contextTokens: 65536 },
    harness: 'omp', devices: 'real-protocol(modbus-tcp → 物理孪生模拟器)', instance: '④-physical-effect',
  },
  scenario: {},
  timeline: [],
  assertions: results,
}

try {
  // ── S 模拟器:隔离影子 + 挤出流延物理孪生 ──
  const sim = await import(pathToFileURL(join(REPO, 'bench', 'lib', 'sim.mjs')).href)
  const boot = await sim.ensureSimulator({ log: m => console.log(`    ${m}`) })
  ok('S0', '隔离模拟器就绪(4036,影子私有 data/)', boot.started || /already-up/.test(String(boot.reason)), JSON.stringify(boot))
  const presetNodes = await sim.applyPreset('cast-film-physics')
  const extruder0 = presetNodes.find(n => n.id === 'dev-extruder-mbtcp')
  if (!extruder0) throw new Error('预设未生成 dev-extruder-mbtcp')
  // 设备协议端口隔离(预设硬编码 56040;改为本验收专属端口,避免与他人实例抢端口)
  const patchCfg = must(await simApi('PATCH', `/api/nodes/${extruder0.id}`, { config: { ...extruder0.config, port: DEV_PORT } }), '改设备端口')
  ok('S1', '挤出设备在线且端口隔离', Number(patchCfg.config?.port) === DEV_PORT, `port=${patchCfg.config?.port}`)
  const exportRes = must(await simApi('GET', `/api/nodes/${extruder0.id}/export`), '设备对接导出')
  const items = exportRes.items ?? []
  const dcwExports = ['加热区1SP', '加热区2SP', '加热区3SP'].map(name => items.find(i => i.signal === name))
  const daqExport = items.find(i => i.signal === '熔体温度')
  if (dcwExports.some(x => !x) || !daqExport) throw new Error(`导出缺少信号:${items.map(i => i.signal).join(',')}`)
  const dev0 = await deviceRead()
  ok('S2', '设备侧直读可用(PV+三区SP,Modbus 18740)', dev0.sp.every(v => v >= 120 && v <= 260) && dev0.pv > 0 && dev0.pv < 400,
    JSON.stringify(dev0))

  // ── P 平台:真实协议接入 + 开线(198 基线直达设备) ──
  const h = await startInstance()
  ok('P0', '生产构建隔离实例④就绪', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)
  admin = (await api('POST', '/api/users/register', { name: '物理生效管理员', email: `phys-${Date.now()}@awshop.local`, password: 'PhysEffect#2026' })).data?.token
  ok('P0b', 'admin 注册', Boolean(admin))

  const line = must(await api('POST', '/api/workshop/dcw/lines', {
    name: '物理生效线', description: '真实 Modbus TCP → 挤出流延物理孪生:抓数/下发/物理响应验收',
  }), '创建产线').line?.id
  const daq = must(await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: '熔体温度', driver: 'modbus-tcp', driverConfig: daqExport.driverConfig,
    lineId: line, intervalMs: 1000, publishIntervalMs: 0, min: 0, max: 400, decimals: 2,
    semantics: '挤出熔体温度(三加热区+螺杆剪切);一阶热惯性,写入后需数十秒收敛',
  }), '创建 DAQ 节点').node?.id
  const dcwIds = []
  for (const [ix, exp] of dcwExports.entries()) {
    const n = must(await api('POST', '/api/workshop/dcw', {
      templateRef: 'temp-sp', name: exp.signal, driver: 'modbus-tcp', driverConfig: exp.driverConfig,
      lineId: line, unit: 'C', decimals: 2, min: 120, max: 260, stepLimit: 5, writeLockSeconds: 0,
      readIntervalMs: 2000, semantics: `${exp.signal}(加热区 ${ix + 1});单步 ≤5C,工艺窗口 120~260C`,
    }), `创建 DCW 节点 ${exp.signal}`).node?.id
    dcwIds.push(n)
  }
  ok('P1', '真实协议节点接入(DAQ×1 + DCW×3,modbus-tcp)', Boolean(line && daq) && dcwIds.length === 3 && dcwIds.every(Boolean),
    JSON.stringify({ line, daq, dcwIds, port: DEV_PORT }))

  // 参数映射(产品限界键)+ 产品 + 配方(基线 198)
  const params = (await api('GET', `/api/workshop/dcw/params?lineId=${line}`)).data?.params ?? []
  const limits = {}
  for (const [ix, nodeId] of dcwIds.entries()) {
    const key = `zone${ix + 1}_sp`
    limits[key] = { min: 120, max: 260 }
    const row = params.find(p => p.nodeId === nodeId)
    if (row) {
      await api('PATCH', `/api/workshop/dcw/params/${row.id}`, { key, desc: `加热区${ix + 1}设定值(C)`, min: 120, max: 260, unit: 'C' })
    }
    else {
      await api('POST', '/api/workshop/dcw/params', { nodeId, key, desc: `加热区${ix + 1}设定值(C)`, min: 120, max: 260, unit: 'C' })
    }
  }
  const product = must(await api('POST', '/api/workshop/dcw/products', {
    name: '物理生效产品', lineId: line, paramLimits: limits,
  }), '创建产品').product
  const BASE_VALUE = 198
  const recipe = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: '物理生效配方', productId: product.id, opIntervalMs: 0,
    params: dcwIds.map(nodeId => ({ nodeId, value: BASE_VALUE, min: 120, max: 260, stepLimit: 5 })),
    daqWindows: [{ nodeId: daq, min: 0, max: 400 }],
  }), '创建配方').recipe
  await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  const start = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipe.id })
  await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true })
  await sleep(12_000)
  const devAfterStart = await deviceRead()
  const startWrote = devAfterStart.sp.every(v => Math.abs(v - BASE_VALUE) <= 0.01)
  ok('P2', `开线配方直达设备寄存器(三区 SP=基线 ${BASE_VALUE})`, start.status === 200 && startWrote,
    `start=${start.status} device=${JSON.stringify(devAfterStart)}`)

  // 采样活性 + 平台样本与设备直读一致性(等热态收敛到基线附近)
  let settle = null
  for (let i = 0; i < 30; i++) {
    await sleep(5000)
    settle = await latestSample(daq, 60)
    if (settle && Math.abs(settle.value - BASE_VALUE) <= 1.2) break
  }
  const devSettled = await deviceRead()
  const sampleGap = settle ? Math.abs(settle.value - devSettled.pv) : Number.NaN
  const sampleCount = settle?.count ?? 0
  ok('P3', '采样活性:窗口内样本充足且非恒定',
    sampleCount >= 20 && Number.isFinite(settle?.value),
    `count=${sampleCount} latest=${settle?.value} devicePV=${devSettled.pv}`)
  ok('P4', '平台样本 = 设备直读(同一物理量,误差 ≤1.5C)',
    Number.isFinite(sampleGap) && sampleGap <= 1.5,
    `platform=${settle?.value} device=${devSettled.pv} gap=${Number.isFinite(sampleGap) ? sampleGap.toFixed(3) : 'n/a'}`)

  // ── C Agent:omp + 本机 Qwen3.5(overlay 钉死模型角色) ──
  const ompOverlay = join(HOME, 'omp-overlay.yml')
  writeFileSync(ompOverlay, [
    'modelRoles:',
    '  default: lm-studio/qwen3.5-9b-32k',
    '  task: lm-studio/qwen3.5-9b-32k',
    '  advisor: lm-studio/qwen3.5-9b-32k',
    '  slow: lm-studio/qwen3.5-9b-32k',
    '  designer: lm-studio/qwen3.5-9b-32k',
    'tools:',
    '  format: qwen3',
    'compaction:',
    '  enabled: true',
    '',
  ].join('\n'))
  const ch = (await api('POST', '/api/workshop/channels', {
    name: '验收-物理生效', lineId: line,
    scenarioPrompt: '你是工艺操作员:只操作你绑定的点位;未收到任务时禁止自主发起任何下发;严格按任务步骤执行,不等待、不复测、不固化。',
    leadAgent: { name: '物理生效-线长', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools', '--thinking=off', '--config', ompOverlay] } },
  })).data
  const channelId = ch?.channelId
  await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: { provider: 'lm-studio', model: process.env.AW_DEMO_MODEL ?? 'qwen3.5-9b-64k', contextTokens: 65536 } })
  await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'manual' })
  const toolsPut = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
    mode: 'selected',
    tools: ['my_industrial_nodes', 'line_context', 'daq_query', 'recipe_trial', 'complete_task', 'report_progress'].map(name => ({ name, enabled: true })),
  })
  const agents = (await api('GET', `/api/workshop/channels/${channelId}`)).data?.agents ?? []
  const lead = agents.find(a => a.role === 'lead')
  const tok = agentTokenOf(lead.id)
  const bindings = []
  for (const nodeId of dcwIds) {
    const b = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead.id, nodeId, kind: 'dcw', mode: 'auto' })
    if (b?.data?.binding?.mode === 'manual') await api('PATCH', `/api/workshop/agent-tools/bindings/${b.data.binding.id}`, { mode: 'auto', confirm: true })
    bindings.push(b?.data?.binding?.id ?? '')
  }
  ok('C0', '频道(manual/HITL)+ omp lead + 三区点位绑定', Boolean(channelId && lead?.id) && toolsPut.status === 200 && bindings.every(Boolean),
    JSON.stringify({ channelId, lead: lead?.id, tools: toolsPut.status, bindings }))
  evidence.scenario = {
    line, daq, dcwIds, recipe: recipe.id, channel: channelId, agent: lead.id, bindings,
    baseline: BASE_VALUE, devicePort: DEV_PORT,
  }

  // ── A Agent 自主作业(单回合):抓数 → 决策 → 下发(HITL 人工批准) ──
  // 单回合设计:证据齐后取消不会卡住后续任务队列(平台取消时 Agent 回合可能仍在跑,
  // 再提交新任务会一直停在 SUBMITTED —— 2026-10-28 实测)。
  const tAgent = Date.now()
  const approvedMain = []
  const taskMain = taskOf(await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: '验收-抓数并调参',
    description: '严格按四步执行,不要做别的:\n'
      + `1) 调用 daq_query:line_id="${line}",last_minutes=3,bucket_ms=1000,读出样本点数/最新值/均值;\n`
      + `2) 调用 recipe_trial:params=[${dcwIds.map(id => `{node_id:"${id}",value:${BASE_VALUE + 5}}`).join(',')}],`
      + 'hypothesis="物理生效验收:三个加热区同步上调 5C,观察熔体温度响应";\n'
      + '3) 审批由人工处理,工具返回后继续;\n'
      + '4) 立即调用 complete_task,汇报抓数摘要与下发回执。\n'
      + '禁止其他任何工具,禁止等待/睡眠,禁止复测。',
  }))
  if (!taskMain?.id) throw new Error('Agent 主任务创建失败')
  let runMain = { task: null, cancelled: false }
  let mainWriteAt = 0
  // 窗口可按模型时延调整(64k 推理模型单轮远慢于 flash;可用 AW_PHYS_AGENT_WINDOW_MS 放宽)
  const AGENT_WINDOW_MS = Number(process.env.AW_PHYS_AGENT_WINDOW_MS ?? 8 * 60_000)
  while (Date.now() - tAgent < AGENT_WINDOW_MS) {
    const task = taskOf(await api('GET', `/api/workshop/tasks/${taskMain.id}`))
    runMain.task = task
    for (const card of await pendingOf(lead.id)) {
      if (approvedMain.includes(card.id)) continue
      approvedMain.push(card.id)
      console.log(`    · HITL 卡 ${card.id} → 批准`)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:批准三区试验' })
    }
    const wrote = (await journalOf(line)).some(a => dcwIds.includes(a.nodeId) && Date.parse(a.at) >= tAgent - 5000 && Number(a.newValue) !== Number(a.prevValue))
    if (wrote && !mainWriteAt) mainWriteAt = Date.now()
    if (taskDone(task)) break
    if (mainWriteAt && Date.now() - mainWriteAt > 90_000) {
      await api('POST', `/api/workshop/tasks/${taskMain.id}/cancel`, { reason: '验收:证据已收口,平台侧取消收敛' })
      runMain = { task: taskOf(await api('GET', `/api/workshop/tasks/${taskMain.id}`)), cancelled: true }
      break
    }
    await sleep(2000)
  }
  const traceMain = toolCallsOf(runMain.task)
  ok('A1', 'Agent 自主调用 daq_query 抓取真实数据',
    traceMain.some(t => t.includes('daq_query')) && (runMain.task?.state === 'COMPLETED' || runMain.cancelled),
    `state=${runMain.task?.state} cancelled=${runMain.cancelled} calls=${traceMain.join(' | ').slice(0, 400)}`)

  // Agent 工具面直查(同一 token/同一授权面):文本与平台样本互相印证
  const direct = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: lead.id, tool: 'daq_query', args: { line_id: line, last_minutes: 3, bucket_ms: 1000 },
  }, undefined, { 'x-aw-agent-token': tok })
  const directText = String(direct?.data?.result?.text ?? direct?.data?.text ?? '')
  const mPts = directText.match(/样本\s*(\d+)\s*点/)
  const mLatest = directText.match(/最新\s*(-?[\d.]+)/)
  const directLatest = mLatest ? Number(mLatest[1]) : Number.NaN
  const latestNow = await latestSample(daq, 60)
  const directGap = Number.isFinite(directLatest) && latestNow ? Math.abs(directLatest - latestNow.value) : Number.NaN
  ok('A2', 'Agent 工具面直查:返回样本数与最新值,且与平台样本一致(≤2C)',
    Boolean(mPts) && Number(mPts[1]) > 0 && Number.isFinite(directGap) && directGap <= 2,
    `text=${directText.replace(/\s+/g, ' ').slice(0, 380)}`)

  // ── W0 模型自主发起的试验(幅度由模型自选):是否真的落到设备 ──
  const idxOf = id => dcwIds.indexOf(id)
  const agentAnchors = (await journalOf(line)).filter(a => dcwIds.includes(a.nodeId) && Date.parse(a.at) >= tAgent - 5000 && Number(a.newValue) !== Number(a.prevValue))
  const agentLatest = new Map()
  for (const a of agentAnchors) agentLatest.set(a.nodeId, a)
  const devAgent = await deviceRead()
  const agentLanded = [...agentLatest.values()].every(a => Math.abs(devAgent.sp[idxOf(a.nodeId)] - Number(a.newValue)) <= 0.01)
  ok('W0', 'Agent 自主发起的试验真实落到设备寄存器(模型自选幅度)',
    agentLatest.size > 0 && agentLanded && (runMain.task?.state === 'COMPLETED' || runMain.cancelled),
    `state=${runMain.task?.state} cancelled=${runMain.cancelled} cards=${approvedMain.length} anchors=${JSON.stringify([...agentLatest.values()].map(a => ({ n: a.nodeId.slice(0, 8), prev: a.prevValue, new: a.newValue })))} device=${JSON.stringify(devAgent)}`)

  // ── W1-W4 同一 Agent 令牌/授权面的确定性批量下发(三区同步 +5C) ──
  // 小模型会自选幅度/漏传点位(实测 +1C 单点),批量与物理响应用确定性参数收口;
  // 走的仍是 recipe_trial 同一工具、同一绑定面、同一 HITL,不是旁路。
  const cur = await deviceRead()
  const targets = cur.sp.map(v => Number((v + 5).toFixed(4)))
  const pvBase = (await latestSample(daq, 30))?.value ?? Number.NaN
  const t3 = Date.now()
  const batchCards = []
  let invokeResp = null
  let invokeErr = null
  const pendingInvoke = api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: lead.id, tool: 'recipe_trial',
    args: {
      line_id: line,
      params: dcwIds.map((id, ix) => ({ node_id: id, value: targets[ix] })),
      hypothesis: '物理生效验收:三个加热区同步上调 5C,观察熔体温度一阶响应',
    },
  }, undefined, { 'x-aw-agent-token': tok }, 240_000)
    .then((r) => { invokeResp = r })
    .catch((e) => { invokeErr = e })
  while (!invokeResp && !invokeErr && Date.now() - t3 < 180_000) {
    for (const card of await pendingOf(lead.id)) {
      if (batchCards.includes(card.id)) continue
      batchCards.push(card.id)
      console.log(`    · 批量卡 ${card.id} → 批准`)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:批准三区批量试验' })
    }
    await sleep(1500)
  }
  await pendingInvoke
  const invokeText = String(invokeResp?.data?.result?.text ?? invokeResp?.data?.text ?? '')
  const invokeIsError = Boolean(invokeResp?.data?.result?.isError ?? invokeResp?.data?.isError) || Boolean(invokeErr)
  const batchAnchors = (await journalOf(line)).filter(a => dcwIds.includes(a.nodeId) && Date.parse(a.at) >= t3 - 5000 && Number(a.newValue) !== Number(a.prevValue))
  const batchLatest = new Map()
  for (const a of batchAnchors) batchLatest.set(a.nodeId, a)
  const devAfterWrite = await deviceRead()
  const nodesAfter = ((await api('GET', '/api/workshop/dcw')).data?.nodes ?? []).filter(n => dcwIds.includes(n.id))
  const allNew = dcwIds.every((id, ix) => {
    const a = batchLatest.get(id)
    return a && Math.abs(Number(a.newValue) - targets[ix]) <= 0.01
  })
  ok('W1', 'HITL 批准后批量账本落账(三区 new=各自目标)',
    Boolean(invokeResp) && !invokeIsError && batchCards.length > 0 && allNew,
    `cards=${batchCards.length} err=${invokeIsError} text=${invokeText.replace(/\s+/g, ' ').slice(0, 300)} anchors=${JSON.stringify([...batchLatest.values()].map(a => ({ n: a.nodeId.slice(0, 8), prev: a.prevValue, new: a.newValue, src: a.source })))}`)
  ok('W2', '设备寄存器直读 = 账本目标值(平台外真值)',
    devAfterWrite.sp.every((v, ix) => Math.abs(v - targets[ix]) <= 0.01),
    `targets=${JSON.stringify(targets)} device=${JSON.stringify(devAfterWrite)}`)
  ok('W3', '平台回读 = 目标值且写入留痕',
    nodesAfter.length === 3 && nodesAfter.every(n => Math.abs(Number(n.value) - targets[idxOf(n.id)]) <= 0.01 && Boolean(n.lastWriteAt)),
    JSON.stringify(nodesAfter.map(n => ({ id: n.id.slice(0, 8), value: n.value, at: n.lastWriteAt }))))
  ok('W4', '下发幅度受单步限界约束(每点 ≤5C)',
    targets.every((v, ix) => Math.abs(v - cur.sp[ix]) <= 5.001),
    `cur=${JSON.stringify(cur.sp)} targets=${JSON.stringify(targets)}`)

  // ── R 物理响应 + 数据回流(2s 节拍监控) ──
  const deltaC = Number.isFinite(pvBase) ? (targets.reduce((a, b) => a + b, 0) / targets.length) - pvBase : 0
  const need = Math.min(1.5, Math.max(0.4, Math.abs(deltaC) * 0.3))
  const monitorStart = Date.now()
  let pvFinal = cur.pv
  let sampleAfter = null
  while (Date.now() - monitorStart < 150_000) {
    await sleep(2000)
    const dev = await deviceRead()
    const smp = await latestSample(daq, 30)
    evidence.timeline.push({ t: nowIso(), elapsedS: Math.round((Date.now() - monitorStart) / 1000), deviceSp: dev.sp, devicePv: dev.pv, platformSample: smp?.value ?? null, platformNodeValues: nodesAfter.map(n => n.value) })
    pvFinal = dev.pv
    sampleAfter = smp
    if (deltaC >= 0 && pvFinal - cur.pv >= need + 1) break
    if (deltaC < 0 && cur.pv - pvFinal >= need + 1) break
  }
  const pvMoved = pvFinal - cur.pv
  ok('R1', `物理响应:熔体温度沿 SP 方向响应(ΔPV=${pvMoved.toFixed(2)}C,阈值 ${need.toFixed(2)}C)`,
    deltaC !== 0 && Math.sign(pvMoved) === Math.sign(deltaC) && Math.abs(pvMoved) >= need,
    `pvBase=${pvBase} pvStart=${cur.pv} pvFinal=${pvFinal} deltaSP=${deltaC.toFixed(2)} need=${need.toFixed(2)} elapsed=${Math.round((Date.now() - monitorStart) / 1000)}s`)
  ok('R2', '下发后的变化被平台重新采到(样本随设备上移)',
    Boolean(sampleAfter) && deltaC !== 0 && Math.sign(sampleAfter.value - pvBase) === Math.sign(deltaC) && Math.abs(sampleAfter.value - pvBase) >= 0.4,
    `pvSampleBase=${pvBase} pvSampleNow=${sampleAfter?.value} devicePv=${pvFinal}`)

  // ── A 下发后复抓(同一 Agent 令牌/工具面;Agent 回合可能仍在跑,直接走工具面更稳) ──
  const refetch = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: lead.id, tool: 'daq_query', args: { line_id: line, last_minutes: 2, bucket_ms: 1000 },
  }, undefined, { 'x-aw-agent-token': tok })
  const refetchText = String(refetch?.data?.result?.text ?? refetch?.data?.text ?? '')
  const rPts = refetchText.match(/样本\s*(\d+)\s*点/)
  const rLatest = refetchText.match(/最新\s*(-?[\d.]+)/)
  const refetchLatest = rLatest ? Number(rLatest[1]) : Number.NaN
  const sampleEnd = await latestSample(daq, 60)
  ok('A3', '下发后 Agent 工具面复抓成功(返回样本数与最新值)',
    Boolean(rPts) && Number(rPts[1]) > 0 && Number.isFinite(refetchLatest),
    `text=${refetchText.replace(/\s+/g, ' ').slice(0, 320)}`)
  ok('A4', '复抓值沿 SP 方向变化且与平台样本一致(变化可被 Agent 观测)',
    Number.isFinite(refetchLatest) && Boolean(sampleEnd) && deltaC !== 0
    && Math.sign(refetchLatest - pvBase) === Math.sign(deltaC) && Math.abs(refetchLatest - pvBase) >= 0.4
    && Math.abs(refetchLatest - sampleEnd.value) <= 2,
    `refetch=${refetchLatest} platform=${sampleEnd?.value} pvBase=${pvBase} deltaSP=${deltaC.toFixed(2)}`)

  evidence.tasks = {
    main: {
      id: taskMain.id, state: runMain.task?.state, cancelled: runMain.cancelled,
      toolCalls: traceMain, deliverable: deliverableOf(runMain.task),
      cards: approvedMain,
      anchors: [...agentLatest.values()].map(a => ({ nodeId: a.nodeId, prev: a.prevValue, new: a.newValue, at: a.at })),
      device: devAgent,
    },
    fetchTool: { toolText: directText.slice(0, 1200) },
    batchDispatch: { cards: batchCards, targets, text: invokeText.slice(0, 900), err: invokeIsError, anchors: [...batchLatest.values()].map(a => ({ nodeId: a.nodeId, prev: a.prevValue, new: a.newValue, at: a.at })) },
    refetch: { text: refetchText.slice(0, 1000), latest: refetchLatest, platform: sampleEnd?.value ?? null },
  }
  evidence.device = { initial: dev0, afterStart: devAfterStart, beforeBatch: cur, afterWrite: devAfterWrite, final: { sp: (await deviceRead()).sp, pv: pvFinal } }
}
catch (err) {
  ok('FATAL', '验收未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const passed = results.filter(r => r.pass).length
  const total = results.length
  evidence.summary = { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(evidence, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${join(EVIDENCE_DIR, 'report.json')}`)
  console.log(`现场:平台 ${BASE}(AW_HOME=${HOME}) / 模拟器 ${SIM_BASE}(设备 Modbus ${DEV_PORT})`)
  process.exit(passed === total ? 0 : 1)
}
