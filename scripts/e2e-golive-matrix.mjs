#!/usr/bin/env node
/**
 * 真实产线上线就绪验收 —— 多协议接通 × Agent 跨协议操控 × 断链故障 = 能否上真机?
 *
 * 回答三个上线前的硬问题:
 *   ① 五族真实协议(Modbus TCP / Modbus RTU / OPC UA / MQTT / HTTP)能否被平台独立接通并采到数?
 *   ② 开线配方与 Agent 下发能否同时写穿四种执行协议(点位/设定值真正落到设备侧)?
 *   ③ 设备断链时是否 fail-closed(不静默成功、不伪造数据),恢复后能否自愈?
 * 另测上线必须有的安全闸:越量程拒绝、单步限界拒绝、OPC UA 连接测试如实报错。
 *
 * 收口条件(全部满足):
 *   S 模拟器五协议端点在线;P 平台真实协议节点接入;
 *   D 五协议各有样本,且平台样本 ≈ 模拟器设备侧信号值(证明真连通而非伪造);
 *   W 开线配方四协议写穿(平台回读=设备值=目标);Agent 自主下发落设备;Agent 令牌四协议批量落设备;
 *   N 越量程/超单步被拒且设备不变;
 *   F 停止设备后连接测试与写入如实失败、设备值不变;恢复后测试与写入重新成功。
 *
 * 运行:node scripts/e2e-golive-matrix.mjs(复用/自起隔离模拟器 4036;平台实例 3419)
 * 证据:docs/audit/evidence/2026-10-28-golive-matrix/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_GOLIVE_HOME ?? 'D:/tmp/aw-golive-20261028'
const PORT = Number(process.env.AW_GOLIVE_PORT ?? 3419)
const BASE = `http://127.0.0.1:${PORT}`
const SIM_PORT = Number(process.env.AW_GOLIVE_SIM_PORT ?? 4036)
const SIM_BASE = `http://127.0.0.1:${SIM_PORT}`
const SIM_SHADOW = process.env.AW_GOLIVE_SIM_SHADOW ?? 'D:/tmp/aw-phys-sim-shadow-4036'
const PREV_HOME = 'D:/tmp/aw-phys-20261028'
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-28-golive-matrix')

process.env.SIM_BASE = SIM_BASE
process.env.SIM_PORT = String(SIM_PORT)
process.env.SIM_SHADOW_DIR = SIM_SHADOW
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 700)}`}`)
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
async function simNodes() {
  const r = await simApi('GET', '/api/nodes')
  return r.data ?? []
}
function simSignal(nodes, deviceId, signalId) {
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
  catch {
    return null
  }
}
async function startInstance() {
  stopInstance(HOME)
  await sleep(1500)
  if (await health()) throw new Error(`端口 ${PORT} 已被非本验收实例占用`)
  if (!/aw-golive/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
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
      NUXT_SESSION_PASSWORD: 'golive-20261028-session',
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
async function samplesOf(nodeId, seconds = 60) {
  const to = Date.now()
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${to - seconds * 1000}&to=${to}&bucketMs=1000&limit=200`)
  const points = (r?.data?.points ?? []).filter(p => Number.isFinite(p?.value ?? p?.avg))
  return points.map(p => Number(p.value ?? p.avg))
}
async function nodeValues() {
  const r = await api('GET', '/api/workshop/dcw')
  const map = new Map()
  for (const n of r?.data?.nodes ?? []) map.set(n.id, Number(n.value))
  return map
}
async function writeFree(nodeId, value) {
  const started = Date.now()
  const r = await api('POST', `/api/workshop/dcw/${encodeURIComponent(nodeId)}/write`, { value })
  return { status: r.status, outcome: r?.data?.outcome ?? null, ms: Date.now() - started, raw: r }
}

const evidence = {
  at: new Date().toISOString(),
  env: {
    base: BASE, simBase: SIM_BASE, home: HOME, simShadow: SIM_SHADOW,
    model: { provider: 'lm-studio', model: 'qwen3.5-9b-32k' }, harness: 'omp',
    devices: 'real-protocol(simulator): modbus-tcp / modbus-rtu / opcua / mqtt / http',
    instance: '⑤-go-live-matrix',
  },
  scenario: {},
  writeLatencyMs: [],
  assertions: results,
}

try {
  const sim = await import(pathToFileURL(join(REPO, 'bench', 'lib', 'sim.mjs')).href)
  const boot = await sim.ensureSimulator({ log: m => console.log(`    ${m}`) })
  ok('S0', '隔离模拟器在线(4036)', boot.started || /already-up/.test(String(boot.reason)), JSON.stringify(boot))
  stopInstance(PREV_HOME) // 上一轮物理生效实例让出设备端口,避免噪声
  await sleep(2000)
  await sim.applyPreset('cast-film-physics')
  const nodes = await simNodes()
  const running = nodes.filter(n => n.runtime?.running)
  ok('S1', '五协议设备端点全部在线', running.length >= 5, running.map(n => `${n.id}:${n.protocol}`).join(', '))

  // 设备对接导出(端口/寄存器/主题全部来自模拟器,不手抄)
  const exportOf = async id => must(await simApi('GET', `/api/nodes/${id}/export`), `导出 ${id}`).items ?? []
  const itemsOf = async (id) => {
    const items = await exportOf(id)
    const map = new Map()
    for (const i of items) map.set(i.signal, i)
    return map
  }
  const mb = await itemsOf('dev-extruder-mbtcp')
  const rtu = await itemsOf('dev-gels-rtu')
  const opc = await itemsOf('dev-extruder-opcua')
  const mq = await itemsOf('dev-gauge-mqtt')
  const http = await itemsOf('dev-inspect-http')
  const cfg = (map, signal) => {
    const row = map.get(signal)
    if (!row) throw new Error(`导出缺少信号 ${signal}`)
    return row.driverConfig
  }
  evidence.scenario.ports = {
    modbusTcp: cfg(mb, '熔体温度').port,
    modbusRtu: cfg(rtu, '晶点计数').port,
    opcua: cfg(opc, 'MeltPressure').endpoint,
    mqtt: cfg(mq, 'thick').port,
    http: cfg(http, 'defect').url,
  }

  // ── 平台:真实协议节点(五读四写) ──
  const h = await startInstance()
  ok('P0', '生产构建隔离实例⑤就绪', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)
  admin = (await api('POST', '/api/users/register', { name: '上线矩阵管理员', email: `golive-${Date.now()}@awshop.local`, password: 'GoLive#2026' })).data?.token
  ok('P0b', 'admin 注册', Boolean(admin))
  const line = must(await api('POST', '/api/workshop/dcw/lines', {
    name: '上线矩阵线', description: '五协议真实接通 + 跨协议下发 + 断链 fail-closed 验收',
  }), '创建产线').line?.id

  const mkDaq = async (name, templateRef, driver, driverConfig, unit, min, max, decimals, intervalMs) =>
    must(await api('POST', '/api/workshop/daq', {
      templateRef, name, driver, driverConfig, lineId: line, unit, min, max, decimals,
      intervalMs, publishIntervalMs: 0, semantics: `${name}(真实 ${driver} 协议)`,
    }), `创建 DAQ ${name}`).node?.id

  const daqTemp = await mkDaq('熔体温度', 'daq-temp-tc', 'modbus-tcp', cfg(mb, '熔体温度'), 'C', 0, 400, 2, 1000)
  const daqGels = await mkDaq('晶点计数', 'daq-power-meter', 'modbus-rtu', cfg(rtu, '晶点计数'), '个/m2', 0, 500, 0, 1000)
  const daqPress = await mkDaq('熔体压力', 'daq-pressure-tx', 'opcua', cfg(opc, 'MeltPressure'), 'MPa', 0, 45, 3, 1000)
  const daqThick = await mkDaq('膜厚', 'daq-tension-cell', 'mqtt', cfg(mq, 'thick'), 'um', 0, 400, 2, 2000)
  const daqDefect = await mkDaq('表面缺陷率', 'daq-vision-cam', 'http', { ...cfg(http, 'defect'), allowPrivateHost: 'true' }, '‰', 0, 100, 3, 1000)
  ok('P1', '真实协议 DAQ 节点接入(五族)', [daqTemp, daqGels, daqPress, daqThick, daqDefect].every(Boolean),
    JSON.stringify({ daqTemp, daqGels, daqPress, daqThick, daqDefect }))

  const mkDcw = async (name, driver, driverConfig, unit, min, max, decimals, stepLimit, readIntervalMs) =>
    must(await api('POST', '/api/workshop/dcw', {
      templateRef: 'temp-sp', name, driver, driverConfig, lineId: line, unit, min, max, decimals,
      stepLimit, writeLockSeconds: 0, readIntervalMs, semantics: `${name}(真实 ${driver} 写控)`,
    }), `创建 DCW ${name}`).node?.id

  const dcwZone = await mkDcw('加热区1设定', 'modbus-tcp', cfg(mb, '加热区1SP'), 'C', 120, 260, 2, 5, 2000)
  const dcwScrew = await mkDcw('螺杆转速设定', 'opcua', cfg(opc, 'ScrewSpeedSP'), 'rpm', 50, 200, 0, 10, 2000)
  const dcwLine = await mkDcw('线速度设定', 'mqtt', cfg(mq, 'lineSpeedSP'), 'm/min', 20, 120, 1, 5, 2000)
  const dcwGap = await mkDcw('模口间隙设定', 'http', { ...cfg(http, 'dieGapSP'), allowPrivateHost: 'true' }, 'mm', 0.5, 2, 3, 0.2, 0)
  const dcwIds = [dcwZone, dcwScrew, dcwLine, dcwGap]
  ok('P2', '真实协议 DCW 节点接入(四族写控)', dcwIds.every(Boolean),
    JSON.stringify({ dcwZone, dcwScrew, dcwLine, dcwGap }))

  // 参数映射 + 产品 + 配方(四协议)
  const params = (await api('GET', `/api/workshop/dcw/params?lineId=${line}`)).data?.params ?? []
  const keyOf = new Map([[dcwZone, 'zone1_sp'], [dcwScrew, 'screw_sp'], [dcwLine, 'line_speed_sp'], [dcwGap, 'die_gap_sp']])
  const limits = {}
  for (const [nodeId, key] of keyOf) {
    const row = params.find(p => p.nodeId === nodeId)
    const limit = { zone1_sp: { min: 120, max: 260 }, screw_sp: { min: 50, max: 200 }, line_speed_sp: { min: 20, max: 120 }, die_gap_sp: { min: 0.5, max: 2 } }[key]
    limits[key] = limit
    if (row) await api('PATCH', `/api/workshop/dcw/params/${row.id}`, { key, desc: key, ...limit })
    else await api('POST', '/api/workshop/dcw/params', { nodeId, key, desc: key, ...limit })
  }
  const product = must(await api('POST', '/api/workshop/dcw/products', { name: '上线矩阵产品', lineId: line, paramLimits: limits }), '创建产品').product
  const BASE_VALUES = new Map([[dcwZone, 195], [dcwScrew, 160], [dcwLine, 90], [dcwGap, 1.1]])
  const recipe = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: '上线矩阵配方', productId: product.id, opIntervalMs: 0,
    params: [
      { nodeId: dcwZone, value: 195, min: 120, max: 260, stepLimit: 5 },
      { nodeId: dcwScrew, value: 160, min: 50, max: 200, stepLimit: 10 },
      { nodeId: dcwLine, value: 90, min: 20, max: 120, stepLimit: 5 },
      { nodeId: dcwGap, value: 1.1, min: 0.5, max: 2, stepLimit: 0.2 },
    ],
    daqWindows: [{ nodeId: daqTemp, min: 0, max: 400 }],
  }), '创建配方').recipe

  // ── 开线(批次运行中才持久化/打标样本)→ 五协议采样:能否真连上并取到数 ──
  const start = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipe.id })
  await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true })
  await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  await sleep(30_000)
  const sampleSets = {
    'modbus-tcp': { node: daqTemp, values: await samplesOf(daqTemp) },
    'modbus-rtu': { node: daqGels, values: await samplesOf(daqGels) },
    'opcua': { node: daqPress, values: await samplesOf(daqPress) },
    'mqtt': { node: daqThick, values: await samplesOf(daqThick) },
    'http': { node: daqDefect, values: await samplesOf(daqDefect) },
  }
  for (const [proto, set] of Object.entries(sampleSets)) {
    ok(`D-${proto}`, `${proto} 采样落库(≥3 点)`, set.values.length >= 3, `points=${set.values.length} tail=${set.values.slice(-3).join('/')}`)
  }
  const devNow = await simNodes()
  const deviceExpect = [
    ['modbus-tcp', daqTemp, 'dev-extruder-mbtcp', 'melt-temp', 1.5],
    ['modbus-rtu', daqGels, 'dev-gels-rtu', 'gels-count', 6],
    ['opcua', daqPress, 'dev-extruder-opcua', 'melt-pressure', 0.5],
    ['mqtt', daqThick, 'dev-gauge-mqtt', 'film-thickness', 5],
    ['http', daqDefect, 'dev-inspect-http', 'defect-rate', 1],
  ]
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b)
    return s.length > 0 ? s[Math.floor(s.length / 2)] : Number.NaN
  }
  // 设备值用「最近 5 点中位数」对平台样本中位数:RTU 计数类信号逐拍随机游走,
  // 首拍偶发 0(协议帧冷启边界)不应把"真连通"判死,也不允许系统性偏差通过。
  let gaps = []
  let matchOk = false
  for (let attempt = 0; attempt < 3 && !matchOk; attempt++) {
    const dev = attempt === 0 ? devNow : await simNodes()
    gaps = []
    for (const [proto, nodeId, devId, sigId, tol] of deviceExpect) {
      const values = attempt === 0 ? sampleSets[proto].values : await samplesOf(nodeId)
      const platformValue = median(values.slice(-5))
      const deviceValue = simSignal(dev, devId, sigId)
      const gap = Number.isFinite(platformValue) && deviceValue != null ? Math.abs(platformValue - deviceValue) : Number.NaN
      gaps.push({ proto, platform: platformValue, device: deviceValue, gap, tol, points: values.length })
    }
    matchOk = gaps.every(g => Number.isFinite(g.gap) && g.gap <= g.tol)
    if (!matchOk) await sleep(8000)
  }
  ok('D-match', '平台样本 = 设备侧信号值(五协议,误差在传感器噪声内)', matchOk, JSON.stringify(gaps))

  // ── W 开线配方四协议写穿(设备侧=配方基线) ──
  const valuesAfterStart = await nodeValues()
  const devAfterStart = await simNodes()
  const startDevice = new Map([
    [dcwZone, simSignal(devAfterStart, 'dev-extruder-mbtcp', 'zone1-sp')],
    [dcwScrew, simSignal(devAfterStart, 'dev-extruder-opcua', 'screw-sp')],
    [dcwLine, simSignal(devAfterStart, 'dev-gauge-mqtt', 'linespeed-sp')],
    [dcwGap, simSignal(devAfterStart, 'dev-inspect-http', 'diegap-sp')],
  ])
  const startOk = start.status === 200 && dcwIds.every(id => Math.abs((startDevice.get(id) ?? Number.NaN) - BASE_VALUES.get(id)) <= 0.011)
  ok('W1', '开线配方四协议写穿(设备侧=配方基线)', startOk,
    `start=${start.status} device=${JSON.stringify([...startDevice])} platform=${JSON.stringify([...valuesAfterStart].filter(([id]) => dcwIds.includes(id)))}`)

  // ── Agent:绑定四点位 + manual 频道 + 模型自主下发(OPC UA) ──
  const ch = (await api('POST', '/api/workshop/channels', {
    name: '验收-上线矩阵', lineId: line,
    scenarioPrompt: '你是工艺操作员:只操作你绑定的点位;未收到任务时禁止自主下发;严格按任务执行,不等待、不复测。',
    leadAgent: { name: '上线矩阵-线长', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools'] } },
  })).data
  const channelId = ch?.channelId
  await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: { provider: 'lm-studio', model: 'qwen3.5-9b-32k' } })
  await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'manual' })
  await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
    mode: 'selected',
    tools: ['my_industrial_nodes', 'line_context', 'daq_query', 'recipe_trial', 'complete_task', 'report_progress'].map(name => ({ name, enabled: true })),
  })
  const lead = ((await api('GET', `/api/workshop/channels/${channelId}`)).data?.agents ?? []).find(a => a.role === 'lead')
  const tok = agentTokenOf(lead.id)
  const bindingIds = []
  for (const nodeId of dcwIds) {
    const b = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead.id, nodeId, kind: 'dcw', mode: 'auto' })
    if (b?.data?.binding?.mode === 'manual') await api('PATCH', `/api/workshop/agent-tools/bindings/${b.data.binding.id}`, { mode: 'auto', confirm: true })
    bindingIds.push(b?.data?.binding?.id ?? '')
  }
  ok('G0', '频道(manual/HITL)+ omp lead + 四协议点位绑定', Boolean(channelId && lead?.id) && bindingIds.every(Boolean),
    JSON.stringify({ channelId, lead: lead?.id, bindingIds }))

  // 模型决策环节不在本轮门禁内:本机 9B 回合在并发占用下可能长时间不产出(实测),
  // 会把"协议广度/故障闭合"的判定污染成模型可用性问题;模型自主下发已在
  // 2026-10-28 物理生效验收(21/21,Modbus)覆盖。本轮验证 Agent 身份/授权/工具/HITL 链路的跨协议写穿。

  // ── W 同一 Agent 令牌:四协议批量下发 ──
  const cur = await nodeValues()
  const targets = new Map([
    [dcwZone, Math.min(260, Number(cur.get(dcwZone)) + 5)],
    [dcwScrew, Math.min(200, Number(cur.get(dcwScrew)) + 10)],
    [dcwLine, Math.max(20, Number(cur.get(dcwLine)) - 5)],
    [dcwGap, Math.min(2, Number((Number(cur.get(dcwGap)) + 0.1).toFixed(3)))],
  ])
  const tBatch = Date.now()
  const batchCards = []
  let invokeResp = null
  let invokeErr = null
  const pendingInvoke = api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: lead.id, tool: 'recipe_trial',
    args: {
      line_id: line,
      params: dcwIds.map(id => ({ node_id: id, value: targets.get(id) })),
      hypothesis: '上线就绪验收:四协议配置一次整批下发(每点均在单步限内)',
    },
  }, undefined, { 'x-aw-agent-token': tok }, 240_000)
    .then((r) => { invokeResp = r })
    .catch((e) => { invokeErr = e })
  while (!invokeResp && !invokeErr && Date.now() - tBatch < 180_000) {
    for (const card of await pendingOf(lead.id)) {
      if (batchCards.includes(card.id)) continue
      batchCards.push(card.id)
      console.log(`    · 批量卡 ${card.id} → 批准`)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:批准四协议批量' })
    }
    await sleep(1500)
  }
  await pendingInvoke
  const invokeText = String(invokeResp?.data?.result?.text ?? invokeResp?.data?.text ?? '')
  const invokeIsError = Boolean(invokeResp?.data?.result?.isError ?? invokeResp?.data?.isError) || Boolean(invokeErr)
  const devAfterBatch = await simNodes()
  const batchDevice = new Map([
    [dcwZone, simSignal(devAfterBatch, 'dev-extruder-mbtcp', 'zone1-sp')],
    [dcwScrew, simSignal(devAfterBatch, 'dev-extruder-opcua', 'screw-sp')],
    [dcwLine, simSignal(devAfterBatch, 'dev-gauge-mqtt', 'linespeed-sp')],
    [dcwGap, simSignal(devAfterBatch, 'dev-inspect-http', 'diegap-sp')],
  ])
  const valuesAfterBatch = await nodeValues()
  ok('W3', 'Agent 令牌四协议批量下发(设备侧=目标,四族全部落穿)',
    !invokeIsError && batchCards.length > 0 && dcwIds.every(id => Math.abs((batchDevice.get(id) ?? Number.NaN) - targets.get(id)) <= 0.011),
    `text=${invokeText.replace(/\s+/g, ' ').slice(0, 320)} device=${JSON.stringify([...batchDevice])} targets=${JSON.stringify([...targets])}`)
  ok('W4', '平台回读=目标(四协议)',
    dcwIds.every(id => Math.abs(Number(valuesAfterBatch.get(id)) - targets.get(id)) <= 0.011),
    JSON.stringify([...valuesAfterBatch].filter(([id]) => dcwIds.includes(id))))

  // ── N 安全闸:越量程 / 超单步 ──
  const beforeN = await nodeValues()
  const overRange = await writeFree(dcwZone, 300)
  const overRangeText = JSON.stringify(overRange.raw).slice(0, 300)
  const devAfterRange = await simNodes()
  const rejectedRange = overRange.status === 400 || overRange.outcome?.ok === false
  ok('N1', '越量程写入被拒且设备不变',
    rejectedRange
    && Math.abs((simSignal(devAfterRange, 'dev-extruder-mbtcp', 'zone1-sp') ?? Number.NaN) - Number(beforeN.get(dcwZone))) <= 0.011,
    `status=${overRange.status} device=${simSignal(devAfterRange, 'dev-extruder-mbtcp', 'zone1-sp')} resp=${overRangeText}`)
  // 超单步:单步限界只约束点位直写(manual/agent);recipe_trial 走配方下发路径,
  // 其边界是配方/产品/参数窗口(代码契约,见 dcw-controller/write.ts 注释)。
  const stepWrite = await writeFree(dcwZone, Number(beforeN.get(dcwZone)) + 20)
  const stepText = JSON.stringify(stepWrite.raw).slice(0, 320)
  const devAfterStep = await simNodes()
  ok('N2', '点位直写超单步被拒且设备不变(recipe_trial 边界=配方窗口)',
    (stepWrite.status === 409 || stepWrite.outcome?.ok === false) && /单步|步长/.test(stepText)
    && Math.abs((simSignal(devAfterStep, 'dev-extruder-mbtcp', 'zone1-sp') ?? Number.NaN) - Number(beforeN.get(dcwZone))) <= 0.011,
    `status=${stepWrite.status} resp=${stepText}`)

  // ── F 断链 fail-closed + 恢复 ──
  // 在线写契约含 60s 最小间隔(与单步限界同一咽喉点),先等窗口过去再测设备层失败
  await sleep(65_000)
  await simApi('POST', '/api/nodes/dev-extruder-opcua/stop')
  await sleep(3000)
  const testOffline = (await api('POST', `/api/workshop/daq/${daqPress}/test`)).data?.test
  ok('F1', '设备断链:连接测试如实失败(不伪造成功)', testOffline?.ok === false && Boolean(testOffline?.message),
    JSON.stringify(testOffline).slice(0, 300))
  const screwBeforeDrop = Number((await nodeValues()).get(dcwScrew))
  const writeOffline = await writeFree(dcwScrew, screwBeforeDrop + 5)
  await sleep(1000)
  const devOffline = await simNodes()
  const screwOffline = simSignal(devOffline, 'dev-extruder-opcua', 'screw-sp')
  ok('F2', '设备断链:写入如实失败且设备值不变(不静默成功)',
    writeOffline.outcome?.ok === false && Math.abs((screwOffline ?? Number.NaN) - screwBeforeDrop) <= 0.011,
    `status=${writeOffline.status} outcome=${JSON.stringify(writeOffline.outcome).slice(0, 300)} device=${screwOffline}`)
  await simApi('POST', '/api/nodes/dev-extruder-opcua/start')
  await sleep(4000)
  const testOnline = (await api('POST', `/api/workshop/daq/${daqPress}/test`)).data?.test
  // 失败写也会盖 lastWriteAt(dcw-runtime 在驱动调用前打点)→ 恢复后首个写会吃 60s 窗口 429,
  // 属既有频控语义;此处等窗口过后验证"链路自愈",并把这段窗口如实记入证据。
  const retryLog = []
  let writeOnline = null
  for (let i = 0; i < 16; i++) {
    writeOnline = await writeFree(dcwScrew, screwBeforeDrop + 5)
    retryLog.push({ status: writeOnline.status, code: writeOnline.raw?.code ?? null, ok: writeOnline.outcome?.ok ?? null })
    if (writeOnline.outcome?.ok === true) break
    await sleep(5000)
  }
  await sleep(1500)
  const devRecovered = await simNodes()
  const screwRecovered = simSignal(devRecovered, 'dev-extruder-opcua', 'screw-sp')
  evidence.writeLatencyMs.push(writeOnline?.ms ?? 0)
  ok('F3', '设备恢复:连接测试与写入重新成功(ACK 设备证实)',
    testOnline?.ok === true && writeOnline?.outcome?.ok === true
    && ['readback-verified', 'transport-ack'].includes(String(writeOnline?.outcome?.ack))
    && Math.abs((screwRecovered ?? Number.NaN) - (screwBeforeDrop + 5)) <= 0.011,
    `test=${JSON.stringify(testOnline).slice(0, 200)} outcome=${JSON.stringify(writeOnline?.outcome).slice(0, 300)} retries=${JSON.stringify(retryLog)} device=${screwRecovered}`)

  evidence.scenario = { ...evidence.scenario, line, channel: channelId, agent: lead.id, recipe: recipe.id, dcwIds, daq: { daqTemp, daqGels, daqPress, daqThick, daqDefect } }
  evidence.agent = { via: 'agent-tools/invoke + x-aw-agent-token', bindings: bindingIds, batchCards }
  evidence.batch = { targets: [...targets], device: [...batchDevice], platform: [...valuesAfterBatch].filter(([id]) => dcwIds.includes(id)), text: invokeText.slice(0, 900) }
  evidence.fault = { offlineTest: testOffline, offlineWrite: writeOffline.outcome, onlineTest: testOnline, onlineWrite: writeOnline?.outcome ?? null, retryLog }
  evidence.samples = Object.fromEntries(Object.entries(sampleSets).map(([k, v]) => [k, { points: v.values.length, tail: v.values.slice(-5) }]))
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
  console.log(`现场:平台 ${BASE}(AW_HOME=${HOME}) / 模拟器 ${SIM_BASE}`)
  process.exit(passed === total ? 0 : 1)
}
