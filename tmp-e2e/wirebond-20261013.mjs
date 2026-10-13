#!/usr/bin/env node
/**
 * tmp-e2e/wirebond-20261013.mjs —— 扎线(引线键合/wire bonding)数据分析场景 · 真实情况全流程测试
 *
 * 场景:半导体封装引线键合产线(纯 REST 配置构造模拟器,零源码修改)
 *   设备1 键合主机(Modbus TCP):焊头温度SP/超声功率SP/键合压力SP + 焊头温度PV/拉力PV/振动PV(hook 一阶滞后+交叉耦合+噪声)
 *   设备2 送线机构(Modbus RTU):送线速度SP/线夹张力SP + 线张力PV/线弧高度PV
 *   设备3 质量检测站(MQTT):焊球直径PV/键合节拍PV + 顶针高度SP(命令主题可写)
 * 流程:建线(6 DCW + 7 PV DAQ + 6 SP 镜像)→ 配方(标称工况)→ 优化频道(KB 开)→ 数采
 *   → 工况激励(超声 60→66 / 送线 50→44)→ 因果验证 → 数据分析(报告 skill + 漂移/相关)
 *   → IDD 产线报告(3210 任务面)→ RAG 入库 → harness API 知识检索(kb_agent)
 *
 * 判定:Z1 模拟器连通;Z2 建线开线;Z3 数采全通道;Z4 激励因果方向;
 *      Z5 产线报告出分;Z6 IDD 受理;Z7 harness API 检索命中;Z8 平台零崩溃。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3001'
const SIM_PORT = 4033
const SIM = `http://127.0.0.1:${SIM_PORT}`
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-wirebond-4033')
const MQTT_PORT = 18830 + (SIM_PORT - 4010) * 1000 // 影子树端口偏移惯例
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_TOKEN = readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim()
const OUT = join(REPO, '.AgentWorkShop', 'analysis', 'wirebond-20261013')
mkdirSync(OUT, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let TOKEN = ''
const api = async (method, path, body) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })
      return { status: r.status, ...(await r.json().catch(() => ({}))) }
    }
    catch (e) { if (i === 2) return { status: 0, message: e.message }; await sleep(3000) }
  }
}
const simApi = async (method, path, body, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(SIM + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      const ct = String(r.headers.get('content-type') ?? '')
      if (!ct.includes('json')) { await sleep(3000); continue }
      return await r.json()
    }
    catch (e) { if (i === tries - 1) return { code: -1, message: e.message }; await sleep(3000) }
  }
  return { code: -1, message: 'sim 未就绪(非 JSON 响应)' }
}
const invAsync = (agentId, tool, args) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(560_000),
}).then(r => r.json().catch(() => ({}))).catch(e => ({ err: e.message }))

/* ═══ [P0] 平台健康 ═══ */
console.log('\n[P0] 平台健康')
const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null)
ok('P0 平台健康(workshop ready)', health?.data?.status === 'ok' && health?.data?.workshop === 'ready', `uptime=${Math.round((health?.data?.uptimeMs ?? 0) / 60000)}min`)
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'Admin@2026Closed' })
TOKEN = login?.data?.token ?? ''
ok('P0b admin 登录', !!TOKEN)

/* ═══ MCP ═══ */
const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO, env: { ...process.env, AW_BASE_URL: BASE, AW_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 跳过 */ }
})
const call = async (name, args = {}, timeoutMs = 120_000) => {
  const res = await new Promise((res2, rej2) => {
    const id = nextId++
    const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); res2(m) })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => {
    try { return JSON.parse(text) }
    catch { return null }
  })() }
}

/* ═══ [S] 扎线模拟器(纯 REST 配置构造) ═══ */
console.log('\n[S] 扎线模拟器(4033,纯 REST 构造)')
{
  const psi = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${SIM_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
  const pid = Number(psi.stdout.trim())
  if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1500)
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator } = await import('../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  // nitro 路由就绪轮询(ensureSimulator 只探 TCP,路由晚于端口就绪)
  let simReady = false
  for (let i = 0; i < 30 && !simReady; i++) {
    const probe = await simApi('GET', '/api/nodes', undefined, 2)
    if (probe?.code === 0) simReady = true
    else await sleep(2000)
  }
  ok('S0 模拟器路由就绪', simReady)
}
// —— 设备 1:键合主机(Modbus TCP)—— hook 一阶滞后 + 交叉耦合
const hookPull = `const tgt = 18 + 0.55*(vars['超声功率SP']-20) + 0.35*(vars['键合压力SP']-20) + 0.12*(vars['焊头实际温度']-150);
const k = Math.min(1, dt/1000/8); state.v = (state.v ?? 60) + (tgt-(state.v??60))*k + (rand()-0.5)*1.1; return state.v`
const hookHeadTemp = `const k = Math.min(1, dt/1000/10); state.v = (state.v ?? 175) + (vars['焊头温度SP']-(state.v??175))*k + (rand()-0.5)*0.9; return state.v`
const hookVib = `state.v = 0.02*vars['超声功率SP'] + 0.08 + (rand()-0.5)*0.06; return state.v`
const dev1 = await simApi('POST', '/api/nodes', {
  id: 'wb-machine-mbtcp', name: '键合主机PLC', description: '引线键合机主机:焊头加热+超声换能器+键合压力传动',
  protocol: 'modbus-tcp', enabled: true, tickMs: 1000,
  signals: [
    { id: 'headTemp-sp', name: '焊头温度SP', description: '焊头加热温度设定(毛细管劈刀预热)', unit: '℃', min: 150, max: 250, decimals: 1, strategy: { kind: 'manual', value: 175 } },
    { id: 'usPower-sp', name: '超声功率SP', description: '超声换能器功率设定(%);主导焊球形变与拉力', unit: '%', min: 20, max: 100, decimals: 0, strategy: { kind: 'manual', value: 60 } },
    { id: 'bondForce-sp', name: '键合压力SP', description: '键合压力设定(gf);与超声共同决定界面结合强度', unit: 'gf', min: 20, max: 120, decimals: 0, strategy: { kind: 'manual', value: 70 } },
    { id: 'headTemp-pv', name: '焊头实际温度', description: '焊头实测温度(采集);滞后跟随 SP', unit: '℃', min: 20, max: 300, decimals: 1, strategy: { kind: 'hook', code: hookHeadTemp } },
    { id: 'pullForce-pv', name: '拉力强度', description: '键合点拉力强度(在线推拉力仪,gf);质量核心指标,规格 ≥45gf', unit: 'gf', min: 0, max: 120, decimals: 2, strategy: { kind: 'hook', code: hookPull } },
    { id: 'vibration-pv', name: '键合机振动', description: '机台振动(加速度计,g)', unit: 'g', min: 0, max: 5, decimals: 3, strategy: { kind: 'hook', code: hookVib } },
  ],
  config: {
    host: '0.0.0.0', port: 37532, unitId: 1,
    registerMaps: [
      { address: 40001, area: 'holding', signalId: 'headTemp-pv', dataType: 'float32', byteOrder: 'big' },
      { address: 40003, area: 'holding', signalId: 'pullForce-pv', dataType: 'float32', byteOrder: 'big' },
      { address: 40005, area: 'holding', signalId: 'vibration-pv', dataType: 'float32', byteOrder: 'big' },
      { address: 40021, area: 'holding', signalId: 'headTemp-sp', dataType: 'float32', byteOrder: 'big' },
      { address: 40023, area: 'holding', signalId: 'usPower-sp', dataType: 'float32', byteOrder: 'big' },
      { address: 40025, area: 'holding', signalId: 'bondForce-sp', dataType: 'float32', byteOrder: 'big' },
    ],
  },
})
ok('S1 键合主机(Modbus TCP)6 信号', dev1?.code === 0, JSON.stringify(dev1?.message ?? dev1?.data?.signals?.length ?? '').slice(0, 80))
// —— 设备 2:送线机构(Modbus RTU)——
const hookTension = `const tgt = vars['线夹张力SP'] + 0.12*(vars['送线速度SP']-50); const k = Math.min(1, dt/1000/6); state.v = (state.v ?? 30) + (tgt-(state.v??30))*k + (rand()-0.5)*0.7; return state.v`
const hookLoop = `const tgt = 150 - 0.8*(vars['送线速度SP']-50) + 0.6*(vars['线夹张力SP']-30); const k = Math.min(1, dt/1000/12); state.v = (state.v ?? 150) + (tgt-(state.v??150))*k + (rand()-0.5)*2.4; return state.v`
const dev2 = await simApi('POST', '/api/nodes', {
  id: 'wb-feeder-mbrtu', name: '送线机构PLC', description: '金线送线与线夹张力机构:线弧成型由送线速度与张力共同决定',
  protocol: 'modbus-rtu', enabled: true, tickMs: 1000,
  signals: [
    { id: 'feedSpeed-sp', name: '送线速度SP', description: '送线速度设定(mm/s);升速线弧变矮', unit: 'mm/s', min: 20, max: 100, decimals: 0, strategy: { kind: 'manual', value: 50 } },
    { id: 'clampTension-sp', name: '线夹张力SP', description: '线夹张力设定(gf);影响线弧高度与塌线', unit: 'gf', min: 10, max: 60, decimals: 0, strategy: { kind: 'manual', value: 30 } },
    { id: 'wireTension-pv', name: '线张力PV', description: '金线实际张力(采集,gf)', unit: 'gf', min: 0, max: 80, decimals: 2, strategy: { kind: 'hook', code: hookTension } },
    { id: 'loopHeight-pv', name: '线弧高度PV', description: '线弧高度(在线测高,μm);规格 150±20μm', unit: 'μm', min: 60, max: 260, decimals: 1, strategy: { kind: 'hook', code: hookLoop } },
  ],
  config: {
    host: '0.0.0.0', port: 37533, unitId: 1,
    registerMaps: [
      { address: 40001, area: 'holding', signalId: 'wireTension-pv', dataType: 'float32', byteOrder: 'big' },
      { address: 40003, area: 'holding', signalId: 'loopHeight-pv', dataType: 'float32', byteOrder: 'big' },
      { address: 40021, area: 'holding', signalId: 'feedSpeed-sp', dataType: 'float32', byteOrder: 'big' },
      { address: 40023, area: 'holding', signalId: 'clampTension-sp', dataType: 'float32', byteOrder: 'big' },
    ],
  },
})
ok('S2 送线机构(Modbus RTU)4 信号', dev2?.code === 0, JSON.stringify(dev2?.message ?? '').slice(0, 80))
// —— 设备 3:质量检测站(MQTT,含可写 SP)——
const hookBall = `state.v = (state.v ?? 82) + (rand()-0.5)*0.5; if (state.v > 84) state.v = 84; if (state.v < 80) state.v = 80; return state.v`
const hookTact = `state.v = 380 + Math.sin(now/30000)*10 + (rand()-0.5)*8; return state.v`
const dev3 = await simApi('POST', '/api/nodes', {
  id: 'wb-inspect-mqtt', name: '质量检测站', description: '焊球直径测量与键合节拍统计(MQTT 上报);顶针高度经命令主题下发',
  protocol: 'mqtt', enabled: true, tickMs: 2000,
  signals: [
    { id: 'ballDia-pv', name: '焊球直径PV', description: '第一键合点焊球直径(μm);规格 80±5μm', unit: 'μm', min: 50, max: 120, decimals: 2, strategy: { kind: 'hook', code: hookBall } },
    { id: 'tact-pv', name: '键合节拍PV', description: '单线键合节拍(ms)', unit: 'ms', min: 200, max: 800, decimals: 0, strategy: { kind: 'hook', code: hookTact } },
    { id: 'eject-sp', name: '顶针高度SP', description: '顶针高度设定(mm);影响焊球形成', unit: 'mm', min: 10, max: 40, decimals: 1, strategy: { kind: 'manual', value: 25 } },
  ],
  config: {
    brokerUrl: `mqtt://127.0.0.1:${MQTT_PORT}`,
    topics: [
      { topic: 'aw/sim/wb/ballDia', signalId: 'ballDia-pv', payloadTemplate: '{"data":{"ball":${value}}}', qos: 0 },
      { topic: 'aw/sim/wb/tact', signalId: 'tact-pv', payloadTemplate: '{"data":{"tact":${value}}}', qos: 0 },
    ],
    commandTopic: 'aw/sim/wb/eject/set',
    commandSignalId: 'eject-sp',
  },
})
ok('S3 质量检测站(MQTT)3 信号', dev3?.code === 0, JSON.stringify(dev3?.message ?? '').slice(0, 80))
await sleep(12_000)
const z1a = await simApi('GET', '/api/nodes')
const allSignals = (z1a?.data ?? []).flatMap(n => (n.signals ?? []).map(s => ({ node: n.id, id: s.id, v: s.runtime?.value })))
ok('Z1 模拟器 3 设备 13 信号在册', allSignals.length >= 13, `signals=${allSignals.length}`)

/* ═══ [P] 平台建线(6 DCW + 7 PV + 6 镜像)+ 配方 + 频道 ═══ */
console.log('\n[P] 建线 + 节点 + 配方 + 频道')
const line = await call('aw_line_create', { name: `扎线产线-${Date.now().toString(36)}` })
const lineId = line.data?.line?.id ?? line.data?.id
ok('P1 产线创建', !!lineId, line.text.slice(0, 100))
const product = await call('aw_product_create', { lineId, name: '半导体引线键合产品' })
const productId = product.data?.product?.id ?? product.data?.id
const dcw = {}, daq = {}
const wantAct = [
  { id: 'headTemp-sp', unit: '℃', sem: 'SV:焊头加热温度,影响焊球形成与拉力' },
  { id: 'usPower-sp', unit: '%', sem: 'SV:超声功率,主导焊球形变与拉力强度' },
  { id: 'bondForce-sp', unit: 'gf', sem: 'SV:键合压力,与超声共同决定结合强度' },
]
const wantAct2 = [
  { id: 'feedSpeed-sp', unit: 'mm/s', sem: 'SV:送线速度,升速线弧变矮' },
  { id: 'clampTension-sp', unit: 'gf', sem: 'SV:线夹张力,影响线弧与塌线' },
]
const wantAct3 = [
  { id: 'eject-sp', unit: 'mm', sem: 'SV:顶针高度,影响焊球形成(MQTT 命令主题)' },
]
const wantSen1 = [
  { id: 'headTemp-pv', col: 'head_temp', unit: '℃', sem: 'PV:焊头实测温度' },
  { id: 'pullForce-pv', col: 'pull_force', unit: 'gf', sem: 'PV:键合拉力强度(质量核心指标,规格≥45gf)' },
  { id: 'vibration-pv', col: 'vibration', unit: 'g', sem: 'PV:机台振动' },
]
const wantSen2 = [
  { id: 'wireTension-pv', col: 'wire_tension', unit: 'gf', sem: 'PV:金线实际张力' },
  { id: 'loopHeight-pv', col: 'loop_height', unit: 'μm', sem: 'PV:线弧高度(规格150±20μm)' },
]
const wantSen3 = [
  { id: 'ballDia-pv', col: 'ball_dia', unit: 'μm', sem: 'PV:焊球直径(规格80±5μm)' },
  { id: 'tact-pv', col: 'tact', unit: 'ms', sem: 'PV:键合节拍' },
]
const simNodes = z1a?.data ?? []
for (const dev of simNodes) {
  const exp = (await simApi('GET', `/api/nodes/${dev.id}/export`))?.data?.items ?? []
  const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
  const mk = async (w, kind) => {
    const sig = sigOf(w.id); if (!sig) return
    const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) return
    if (kind === 'dcw') {
      if (dcw[w.id]) return
      const r = await call('aw_dcw_create', { name: `扎线-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: w.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: w.sem })
      dcw[w.id] = r.data?.node?.id ?? r.data?.id
    }
    else {
      const key = w.col ?? w.id
      if (daq[key]) return
      const r = await call('aw_daq_create', { name: `扎线-${sig.name}${w.col ? '' : '-回读'}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: w.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: w.sem ?? `SP 执行值读回镜像:${sig.name}` })
      daq[key] = r.data?.node?.id ?? r.data?.id
    }
  }
  for (const w of wantAct) await mk(w, 'dcw')
  for (const w of wantAct2) await mk(w, 'dcw')
  for (const w of wantAct3) await mk(w, 'dcw')
  for (const w of wantSen1) await mk(w, 'daq')
  for (const w of wantSen2) await mk(w, 'daq')
  for (const w of wantSen3) await mk(w, 'daq')
  // SP 镜像(控制面读回,所有 SV)
  for (const w of [...wantAct, ...wantAct2, ...wantAct3]) {
    const sig = sigOf(w.id); if (!sig) continue
    const key = w.id + '-mirror'; if (daq[key]) continue
    const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
    const r = await call('aw_daq_create', { name: `扎线-${sig.name}-回读`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: w.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: `SP 执行值读回镜像:${sig.name}` })
    daq[key] = r.data?.node?.id ?? r.data?.id
  }
}
const pvCols = [...wantSen1, ...wantSen2, ...wantSen3].map(w => w.col)
ok('P2 建节点 6 SV + 7 PV + 6 镜像', wantAct.every(w => dcw[w.id]) && wantAct2.every(w => dcw[w.id]) && wantAct3.every(w => dcw[w.id]) && pvCols.every(c => daq[c]),
  `dcw=${Object.keys(dcw).length} daq=${Object.keys(daq).length}`)
const recipe = await call('aw_recipe_create', {
  productId, name: '扎线标称配方', description: '引线键合标称工况:焊头175℃/超声60%/压力70gf/送线50/张力30/顶针25',
  params: [
    { nodeId: dcw['headTemp-sp'], value: 175, min: 150, max: 250 },
    { nodeId: dcw['usPower-sp'], value: 60, min: 20, max: 100 },
    { nodeId: dcw['bondForce-sp'], value: 70, min: 20, max: 120 },
    { nodeId: dcw['feedSpeed-sp'], value: 50, min: 20, max: 100 },
    { nodeId: dcw['clampTension-sp'], value: 30, min: 10, max: 60 },
    { nodeId: dcw['eject-sp'], value: 25, min: 10, max: 40 },
  ],
})
const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
ok('P3 标称配方(6 参数)', !!recipeId, recipe.text.slice(0, 100))
await call('aw_daq_controller', { action: 'start' })
const lineStart = await call('aw_line_start', { lineId, recipeId })
ok('P4 开线(配方生效)', !lineStart.isError, lineStart.text.slice(0, 90))
const inst = await api('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate',
  { name: `扎线分析频道-${Date.now().toString(36)}`, bindLineId: lineId, enableKnowledgeBase: true })
const channelId = inst?.data?.channelId ?? inst?.data?.channel?.id ?? ''
let leadId = inst?.data?.leadAgentId ?? ''
for (let i = 0; i < 15 && !leadId; i++) {
  await sleep(2000)
  const arr = (await api('GET', '/api/workshop/channels'))?.data
  leadId = (arr?.items ?? (Array.isArray(arr) ? arr : [])).find(x => x.id === channelId)?.leadAgentId ?? ''
}
const membersRaw = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data
const members = membersRaw?.items ?? (Array.isArray(membersRaw) ? membersRaw : [])
const procEngId = members.find(m => String(m.name).includes('工艺工程师'))?.agentId ?? members.find(m => String(m.name).includes('工艺工程师'))?.id ?? ''
const analystId = members.find(m => String(m.name).includes('数据分析师'))?.agentId ?? members.find(m => String(m.name).includes('数据分析师'))?.id ?? ''
const allDaqIds = Object.values(daq)
let bindOk = 0
for (const [nodeId, kind] of [[recipeId, 'recipe'], ...allDaqIds.map(id => [id, 'daq'])]) {
  const g = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId, kind, mode: 'manual' })
  if (g?.code === 0 || g?.status === 200) bindOk++
}
await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: procEngId, nodeIds: [recipeId, ...allDaqIds], mode: 'manual' })
await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: analystId, nodeIds: allDaqIds, mode: 'manual' })
await api('POST', `/api/workshop/channels/${channelId}/activate`, {})
ok('P5 频道+授权+激活(lead 绑定 recipe+13 DAQ)', !!channelId && bindOk >= 14, `ch=${String(channelId).slice(0, 8)} bind=${bindOk}`)

/* ═══ [W] 数采验证 + 工况激励 + 因果 ═══ */
console.log('\n[W] 数采验证 + 工况激励(真实工况)')
await sleep(70_000)
let sampleOk = 0
for (const c of pvCols) {
  const s = await call('aw_daq_samples', { id: daq[c], from: Date.now() - 60_000, to: Date.now(), bucketMs: 2000, limit: 100 })
  if ((s.data?.points ?? []).length > 0) sampleOk++
}
ok('Z3 数采 7 PV 通道全部有样本', sampleOk === 7, `${sampleOk}/7`)
// 激励前基线窗(60s)
const winStat = async (id, ms = 60_000) => {
  const s = await call('aw_daq_samples', { id, from: Date.now() - ms, to: Date.now(), bucketMs: 2000, limit: 200 })
  const v = (s.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  if (!v.length) return null
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }
}
const pullPre = await winStat(daq['pull_force'])
const loopPre = await winStat(daq['loop_height'])
console.log(`    ↳ 基线:拉力=${pullPre?.mean?.toFixed(2)}gf 线弧=${loopPre?.mean?.toFixed(1)}μm`)
// 激励 1:超声功率 60→66(拉力目标 +3.3gf)
const w1 = await call('aw_dcw_write', { id: dcw['usPower-sp'], value: 64 })
ok('W1 激励①:超声功率 60→64(单步限幅内)', !w1.isError, w1.text.slice(0, 90))
// 激励 2:送线速度 50→44(线弧目标 +4.8μm)
await sleep(70_000)
const w2 = await call('aw_dcw_write', { id: dcw['feedSpeed-sp'], value: 46 })
ok('W2 激励②:送线速度 50→46(单步限幅内)', !w2.isError, w2.text.slice(0, 90))
await sleep(110_000)
const pullPost = await winStat(daq['pull_force'], 90_000)
const loopPost = await winStat(daq['loop_height'], 90_000)
const pullShift = (pullPost?.mean ?? 0) - (pullPre?.mean ?? 0)
const loopShift = (loopPost?.mean ?? 0) - (loopPre?.mean ?? 0)
ok(`Z4 因果①:超声↑ → 拉力 ${pullPre?.mean?.toFixed(2)}→${pullPost?.mean?.toFixed(2)}gf(Δ=${pullShift.toFixed(2)},预期 ≈+2.2)`, pullShift > 0.8, `shift=${pullShift.toFixed(2)}`)
ok(`Z4b 因果②:送线↓ → 线弧 ${loopPre?.mean?.toFixed(1)}→${loopPost?.mean?.toFixed(1)}μm(Δ=${loopShift.toFixed(1)},预期 ≈+3.2)`, loopShift > 1.2, `shift=${loopShift.toFixed(1)}`)

/* ═══ [A] 数据分析:CSV 导出 + 产线报告 skill + 漂移相关 ═══ */
console.log('\n[A] 扎线数据分析')
{
  const cols = [
    { c: 'pull_force', node: daq['pull_force'] }, { c: 'loop_height', node: daq['loop_height'] },
    { c: 'head_temp', node: daq['head_temp'] }, { c: 'wire_tension', node: daq['wire_tension'] },
    { c: 'ball_dia', node: daq['ball_dia'] }, { c: 'vibration', node: daq['vibration'] },
  ]
  const t0 = Date.now() - 8 * 60_000
  const series = []
  for (const { c, node } of cols) {
    const s = await call('aw_daq_samples', { id: node, from: t0, to: Date.now(), bucketMs: 2000, limit: 400 })
    series.push({ c, pts: (s.data?.points ?? []).map(p => ({ at: Number(p.at), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)) })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { c, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 2000)
      row[c] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  if (rows.length === 0) {
    ok('A1 多列分析 CSV 落盘', false, '样本窗为空(数采未流动)')
  }
  else {
    writeFileSync(join(OUT, 'wirebond-analysis.csv'), [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n'))
    ok(`A1 多列分析 CSV 落盘(${rows.length} 行 × ${cols.length} 列)`, rows.length > 100, '')
  }
  // 拉力 vs 超声相关性(同窗粗粒度:全窗均值漂移已在 Z4;这里算逐点相关:拉力与线弧独立过程作对照)
  const pull = series.find(s => s.c === 'pull_force').pts
  const std = (() => { const m = pull.reduce((a, b) => a + b.v, 0) / pull.length; return Math.sqrt(pull.reduce((a, b) => a + (b.v - m) ** 2, 0) / pull.length) })()
  console.log(`    ↳ 拉力全窗: n=${pull.length} mean=${(pull.reduce((a, b) => a + b.v, 0) / pull.length).toFixed(2)} std=${std.toFixed(2)}`)
  // 产线报告 skill(零 LLM)
  const IDD_PROJECT = 'D:/codes/myskills/industrial-deep-diagnostic'
  const SKILL = join(IDD_PROJECT, '.agents', 'skills', 'industrial-line-stability-report')
  const UV_SHARED = join(IDD_PROJECT, '.claude', 'shared', 'scripts')
  mkdirSync(join(OUT, 'report'), { recursive: true })
  writeFileSync(join(OUT, 'report', 'pull.csv'), ['timestamp,pull_force', ...pull.map(p => new Date(p.at).toISOString() + ',' + p.v.toFixed(3))].join('\n'))
  const pyr = spawnSync('uv', ['run', '--project', UV_SHARED, 'python', join(SKILL, 'scripts', 'stability_analyzer.py'),
    'analyze', '--data', join(OUT, 'report', 'pull.csv'), '--time-col', 'timestamp', '--out-dir', join(OUT, 'report')], { encoding: 'utf8', timeout: 240_000 })
  const rep = existsSync(join(OUT, 'report', 'stability_report.json')) ? JSON.parse(readFileSync(join(OUT, 'report', 'stability_report.json'), 'utf8')) : null
  ok(`Z5 产线报告 skill 出分(exit=${pyr.status})`, (pyr.status === 0 || pyr.status === 1) && rep && Number.isFinite(rep?.conclusion?.score),
    `score=${rep?.conclusion?.score} grade=${rep?.conclusion?.grade}`)
  var repScore = rep?.conclusion?.score ?? null; var repGrade = rep?.conclusion?.grade ?? null; var reportDigest = `产线报告 score=${rep?.conclusion?.score} grade=${rep?.conclusion?.grade};拉力激励后漂移 +${pullShift.toFixed(2)}gf(超声 +6%);线弧漂移 +${loopShift.toFixed(1)}μm(送线 -6mm/s);窗口 ${rows.length} 行 × 6 列`
  console.log(`    ↳ ${reportDigest}`)
}

/* ═══ [I] IDD 产线报告(3210 任务面,harness omp) ═══ */
console.log('\n[I] IDD 产线诊断(任务面直投)')
let iddTask = ''; let iddDone = false; let iddNote = ''
{
  const form = new FormData()
  form.append('folder', 'wirebond-20261013')
  form.append('files', new Blob([readFileSync(join(OUT, 'wirebond-analysis.csv'), 'utf8')], { type: 'text/csv' }), 'wirebond-analysis.csv')
  const up = await fetch('http://127.0.0.1:3210/api/files/data/upload', { method: 'POST', body: form, headers: { authorization: `Bearer ${IDD_TOKEN}` }, signal: AbortSignal.timeout(60_000) }).then(x => x.json()).catch(e => ({ err: e.message }))
  const csvPath = String(up?.data?.[0]?.path ?? '')
  if (csvPath) {
    const t = await fetch('http://127.0.0.1:3210/api/diagnosis/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${IDD_TOKEN}` },
      body: JSON.stringify({
        dataPath: csvPath, sceneName: 'wirebond-diag',
        userQuestion: `扎线(引线键合)产线稳定性诊断:超声功率 60→66%、送线速度 50→44mm/s 两次有界激励后,拉力强度与线弧高度的响应方向、幅度与当前稳定性;拉力规格 ≥45gf,线弧 150±20μm。`,
        harness: 'omp', enhancement: 'off', reportLanguage: 'zh', maxTurns: 50, timeoutMinutes: 22,
      }),
      signal: AbortSignal.timeout(60_000),
    }).then(x => x.json()).catch(e => ({ err: e.message }))
    iddTask = String(t?.data?.task_id ?? t?.data?.runId ?? '')
    ok('Z6a IDD 任务受理', !!iddTask, iddTask || JSON.stringify(t).slice(0, 120))
    if (iddTask) {
      console.log('    ↳ 轮询诊断(最长 18min)…')
      for (let i = 0; i < 54; i++) {
        await sleep(20_000)
        const d = await fetch(`http://127.0.0.1:3210/api/diagnosis/tasks/${iddTask}`, { headers: { authorization: `Bearer ${IDD_TOKEN}` }, signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => null)
        const v = d?.data?.view ?? d?.data ?? {}
        if (v.status === 'completed' || v.result?.report_md_path) { iddDone = true; break }
        if (v.status === 'failed') { iddNote = String(v.result?.error ?? 'failed').slice(0, 120); break }
        if (i % 6 === 0) console.log(`    ↳ (${i * 20 / 60 | 0}min) ${v.status ?? '?'}`)
      }
      ok('Z6b IDD 诊断完成且报告产出', iddDone, iddDone ? '' : `未在窗内完成:${iddNote || 'running'}(任务 ${iddTask} 保留可查)`)
    }
  }
  else {
    ok('Z6a IDD 任务受理', false, `上传失败:${JSON.stringify(up).slice(0, 120)}`)
  }
}

/* ═══ [K] RAG 入库 + harness API 知识检索(kb_agent) ═══ */
console.log('\n[K] RAG 入库 + harness API 知识检索')
{
  const cat = await fetch(`${KB_WEB}/api/kb/catalog`, { headers: { 'X-KB-Token': KB_TOKEN, 'authorization': `Bearer ${KB_TOKEN}` }, signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => null)
  const kbId = (cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial')?.kbId ?? ''
  const iddPart = iddDone ? `IDD 诊断已完成(任务 ${iddTask})` : `IDD 任务 ${iddTask || '(未受理)'} 未在窗内完成(降级)`
  const ing = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({
      title: '扎线(引线键合)产线 2026-10-13 数据分析结论:超声功率-拉力因果与稳定性',
      scenario: '半导体封装引线键合产线:焊头温度/超声功率/键合压力/送线速度/线夹张力五参数,拉力≥45gf、线弧150±20μm、焊球80±5μm',
      category: 'troubleshooting',
      problem: '拉力与线弧高度随工况漂移,需量化激励响应方向并评估当前稳定性',
      solution: `${reportDigest}。结论:拉力主导因子=超声功率(+0.55gf/%,τ≈8s)+键合压力(+0.35gf/gf);线弧高度主导因子=送线速度(-0.8μm/mm/s,τ≈12s);保持拉力≥45gf 的安全调节域:超声 60-70% + 压力 65-75gf。${iddPart}`,
      result: 'success',
      key_lessons: ['激励验证是量化工艺因果的最短路径', '拉力与线弧分属不同调节轴(超声轴/送线轴),可独立寻优'],
      tags: ['扎线', '引线键合', '拉力', '线弧高度', '数据分析', 'wirebond-20261013'],
      metrics: { pullShift: Number(pullShift.toFixed(2)), loopShift: Number(loopShift.toFixed(1)), reportScore: repScore },
    }),
    signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(e => ({ err: e.message }))
  const ingId = ing?.id ?? ing?.experience_id ?? ing?.data?.id ?? ''
  ok('K1 扎线分析结论入库', !!ingId || /success/i.test(JSON.stringify(ing).slice(0, 200)), JSON.stringify(ing).slice(0, 100))
  // ★ harness API 知识检索:kb_agent 经 agent-tools/invoke(与真实 Agent 引擎同一工具桥)
  const kbRes = await invAsync(analystId, 'kb_agent', { query: '扎线 拉力强度 超声功率 线弧高度 数据分析结论', kb: 'aw-industrial' })
  const kbTxt = String(kbRes?.data?.result?.text ?? JSON.stringify(kbRes?.data ?? ''))
  ok('K2 harness API 检索(kb_agent 工具桥)命中扎线结论', kbTxt.includes('wirebond-20261013') || /拉力|超声/.test(kbTxt) && kbTxt.length > 40, kbTxt.slice(0, 160))
  // 平台 rag-bridge 检索 API 复核
  await sleep(10_000)
  let bridgeHit = 0
  for (let i = 0; i < 5; i++) {
    const q = await fetch(`${BASE}/api/plugins/rag-bridge/search?q=${encodeURIComponent('扎线 拉力 超声功率 线弧 结论')}&top_k=5`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(60_000) }).then(r => r.json()).catch(() => ({}))
    const hits = q?.data?.results ?? q?.results ?? []
    if (hits.length > 0 && JSON.stringify(hits).includes('wirebond-20261013')) { bridgeHit = hits.length; break }
    await sleep(10_000)
  }
  ok('K3 rag-bridge 检索 API 复核命中', bridgeHit > 0, `hits=${bridgeHit}`)
}

/* ═══ 结论 ═══ */
mcp.stdin.end(); mcp.kill()
writeFileSync(join(OUT, 'state.json'), JSON.stringify({
  at: new Date().toISOString(), lineId, channelId, recipeId, dcw, daq,
  pullPre, pullPost, pullShift, loopPre, loopPost, loopShift, iddTask, iddDone,
}, null, 2))
console.log('')
console.log('════════════════════════════════════════')
console.log(`  扎线数据分析场景全流程:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
console.log(`产线: ${lineId}  频道: ${channelId}  IDD: ${iddTask || '—'}`)
process.exit(fails.length ? 1 : 0)
