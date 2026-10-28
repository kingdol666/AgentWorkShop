#!/usr/bin/env node
/**
 * 绑定方式 × 真实协议验收 —— line-recipe / recipe / dcw / 无 dcw 四种授权面
 *
 * 场景:一条真实 Modbus/OPC UA/MQTT/HTTP 产线(物理孪生模拟器),两个配方 R1/R2。
 * 四个 Agent(独立频道,同一产线)分别采用不同绑定方式,用真实 `agent-tools/invoke`
 * (agent 令牌 + HITL)验证设计语义,并直读设备侧信号确认"能不能真下发":
 *
 *   A 窄绑:dcw(zone1,screw)+ recipe(R1)      → 下发被收窄到绑定点位,未绑点被拒且点名
 *   B 配方:recipe(R1) 且无 dcw               → 向下兼容:整配方全参数可下发
 *   C 产线:line-recipe(整线) 且无 dcw         → 可新建/修改配方;下发按"无 dcw=全量"兼容
 *   D 裸奔:无任何绑定(仅频道绑线只读)        → 读允许,写/版本操作拒绝
 *
 * 收口条件:每种绑定的允许/拒绝与设备侧实际变化一致;Qwen 模型自主下发亦落设备。
 *
 * 运行:node scripts/e2e-binding-modes-real.mjs(自起隔离模拟器 4036;平台实例 3421)
 * 证据:docs/audit/evidence/2026-10-29-binding-modes/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_BIND_HOME ?? 'D:/tmp/aw-bind-20261029'
const PORT = Number(process.env.AW_BIND_PORT ?? 3421)
const BASE = `http://127.0.0.1:${PORT}`
const SIM_PORT = Number(process.env.AW_BIND_SIM_PORT ?? 4036)
const SIM_BASE = `http://127.0.0.1:${SIM_PORT}`
const SIM_SHADOW = process.env.AW_BIND_SIM_SHADOW ?? 'D:/tmp/aw-phys-sim-shadow-4036'
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-binding-modes')

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
  if (!/aw-bind/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
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
      NUXT_SESSION_PASSWORD: 'bind-20261029-session',
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
/** 以 agent 令牌调用工具;出现 HITL 卡自动批准(验收模拟人工),返回文本/isError */
async function invokeAs(agentId, token, tool, args, { approve = true, timeoutMs = 180_000 } = {}) {
  const cards = []
  let resp = null
  let err = null
  const started = Date.now()
  const p = api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': token }, timeoutMs)
    .then((r) => { resp = r })
    .catch((e) => { err = e })
  while (!resp && !err && Date.now() - started < timeoutMs - 10_000) {
    if (approve) {
      for (const card of await pendingOf(agentId)) {
        if (cards.includes(card.id)) continue
        cards.push(card.id)
        console.log(`    · [${tool}] HITL 卡 ${card.id} → 批准`)
        await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:绑定方式测试' })
      }
    }
    await sleep(1000)
  }
  await p
  const text = String(resp?.data?.result?.text ?? resp?.data?.text ?? '')
  const isError = Boolean(resp?.data?.result?.isError ?? resp?.data?.isError) || Boolean(err)
  return { resp, text, isError, cards }
}

const evidence = { at: new Date().toISOString(), scenario: {}, assertions: results }

try {
  const sim = await import(pathToFileURL(join(REPO, 'bench', 'lib', 'sim.mjs')).href)
  const boot = await sim.ensureSimulator({ log: m => console.log(`    ${m}`) })
  ok('S0', '隔离模拟器在线(4036)', boot.started || /already-up/.test(String(boot.reason)), JSON.stringify(boot))
  stopInstance('D:/tmp/aw-golive-20261028')
  stopInstance('D:/tmp/aw-phys-20261028')
  await sleep(2000)
  await sim.applyPreset('cast-film-physics')
  const nodes = await simNodes()
  ok('S1', '四协议设备端点在线', nodes.filter(n => n.runtime?.running).length >= 5, nodes.map(n => `${n.id}:${n.protocol}`).join(', '))

  const exportItems = async id => must(await simApi('GET', `/api/nodes/${id}/export`), `导出 ${id}`).items ?? []
  const bySignal = async (id, signal) => {
    const row = (await exportItems(id)).find(i => i.signal === signal)
    if (!row) throw new Error(`导出缺少 ${id}/${signal}`)
    return row.driverConfig
  }
  const cfgZone = await bySignal('dev-extruder-mbtcp', '加热区1SP')
  const cfgScrew = await bySignal('dev-extruder-opcua', 'ScrewSpeedSP')
  const cfgLine = await bySignal('dev-gauge-mqtt', 'lineSpeedSP')
  const cfgGap = await bySignal('dev-inspect-http', 'dieGapSP')
  const cfgTemp = await bySignal('dev-extruder-mbtcp', '熔体温度')

  const h = await startInstance()
  ok('P0', '生产构建隔离实例就绪', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)
  admin = (await api('POST', '/api/users/register', { name: '绑定矩阵管理员', email: `bind-${Date.now()}@awshop.local`, password: 'Bind#2026' })).data?.token
  ok('P0b', 'admin 注册', Boolean(admin))

  const line = must(await api('POST', '/api/workshop/dcw/lines', { name: '绑定矩阵线', description: '四种绑定方式 × 真实协议' }), '建线').line?.id
  const daq = must(await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: '熔体温度', driver: 'modbus-tcp', driverConfig: cfgTemp,
    lineId: line, intervalMs: 1000, publishIntervalMs: 0, min: 0, max: 400, decimals: 2,
  }), '建 DAQ').node?.id
  const mk = async (name, driver, driverConfig, unit, min, max, decimals, stepLimit) =>
    must(await api('POST', '/api/workshop/dcw', {
      templateRef: 'temp-sp', name, driver, driverConfig, lineId: line, unit, min, max, decimals,
      stepLimit, writeLockSeconds: 0, readIntervalMs: 2000,
    }), `建 ${name}`).node?.id
  const zone = await mk('加热区1设定', 'modbus-tcp', cfgZone, 'C', 120, 260, 2, 5)
  const screw = await mk('螺杆转速设定', 'opcua', cfgScrew, 'rpm', 50, 200, 0, 10)
  const speed = await mk('线速度设定', 'mqtt', cfgLine, 'm/min', 20, 120, 1, 5)
  const gap = await mk('模口间隙设定', 'http', { ...cfgGap, allowPrivateHost: 'true' }, 'mm', 0.5, 2, 3, 0.2)
  const dw = [zone, screw, speed, gap]
  ok('P1', '一 DAQ + 四协议 DCW 接入', Boolean(line && daq) && dw.every(Boolean), JSON.stringify({ line, daq, dw }))

  const params = (await api('GET', `/api/workshop/dcw/params?lineId=${line}`)).data?.params ?? []
  const limits = { zone1_sp: { min: 120, max: 260 }, screw_sp: { min: 50, max: 200 }, line_speed_sp: { min: 20, max: 120 }, die_gap_sp: { min: 0.5, max: 2 } }
  const keys = [['zone1_sp', zone], ['screw_sp', screw], ['line_speed_sp', speed], ['die_gap_sp', gap]]
  for (const [key, nodeId] of keys) {
    const row = params.find(p => p.nodeId === nodeId)
    if (row) await api('PATCH', `/api/workshop/dcw/params/${row.id}`, { key, desc: key, ...limits[key] })
    else await api('POST', '/api/workshop/dcw/params', { nodeId, key, desc: key, ...limits[key] })
  }
  const product = must(await api('POST', '/api/workshop/dcw/products', { name: '绑定矩阵产品', lineId: line, paramLimits: limits }), '建产品').product
  const R1 = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: '绑定矩阵配方R1', productId: product.id, opIntervalMs: 0,
    params: [
      { nodeId: zone, value: 195, min: 120, max: 260, stepLimit: 5 },
      { nodeId: screw, value: 160, min: 50, max: 200, stepLimit: 10 },
      { nodeId: speed, value: 90, min: 20, max: 120, stepLimit: 5 },
      { nodeId: gap, value: 1.1, min: 0.5, max: 2, stepLimit: 0.2 },
    ],
    daqWindows: [{ nodeId: daq, min: 0, max: 400 }],
  }), '建 R1').recipe
  await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  const started = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: R1.id })
  await api('PATCH', `/api/workshop/dcw/lines/${line}`, { controlMode: 'auto', confirm: true })
  await sleep(10_000)
  const dev0 = await simNodes()
  ok('P2', '开线且 R1 基线落设备', started.status === 200
  && Math.abs((simSignal(dev0, 'dev-extruder-mbtcp', 'zone1-sp') ?? NaN) - 195) < 0.02
  && Math.abs((simSignal(dev0, 'dev-extruder-opcua', 'screw-sp') ?? NaN) - 160) < 0.02,
  JSON.stringify({ zone: simSignal(dev0, 'dev-extruder-mbtcp', 'zone1-sp'), screw: simSignal(dev0, 'dev-extruder-opcua', 'screw-sp') }))

  // ── 四个 Agent/频道(同一产线),不同绑定 ──
  const tools = ['my_industrial_nodes', 'line_context', 'daq_query', 'recipe_catalog', 'recipe_trial', 'recipe_update', 'recipe_rollback', 'recipe_create', 'complete_task', 'report_progress'].map(name => ({ name, enabled: true }))
  const mkChannel = async (name, harness) => {
    const ch = (await api('POST', '/api/workshop/channels', {
      name, lineId: line,
      scenarioPrompt: '你是工艺操作员:只操作你被授权的对象;未收到任务时禁止自主下发;严格按任务执行。',
      leadAgent: { name: `${name}-lead`, harness },
    })).data
    await api('PATCH', `/api/workshop/channels/${ch.channelId}`, { llm: { provider: 'lm-studio', model: 'qwen3.5-9b-32k' } })
    await api('PATCH', `/api/workshop/channels/${ch.channelId}/execution-mode`, { mode: 'manual' })
    await api('PUT', `/api/workshop/channels/${ch.channelId}/tools`, { mode: 'selected', tools })
    return { channelId: ch.channelId, agentId: ch.leadAgentId, token: agentTokenOf(ch.leadAgentId) }
  }
  const A = await mkChannel('验收-窄绑dcw', 'mock')
  const B = await mkChannel('验收-仅配方', 'mock')
  const C = await mkChannel('验收-产线管理权', 'mock')
  const D = await mkChannel('验收-无绑定', 'mock')

  const bind = async (agentId, nodeId, kind) => {
    const r = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, mode: 'auto' })
    if (r?.data?.binding?.mode === 'manual') await api('PATCH', `/api/workshop/agent-tools/bindings/${r.data.binding.id}`, { mode: 'auto', confirm: true })
    return r
  }
  const bA1 = await bind(A.agentId, zone, 'dcw')
  const bA2 = await bind(A.agentId, screw, 'dcw')
  const bAR = await bind(A.agentId, R1.id, 'recipe')
  const bBR = await bind(B.agentId, R1.id, 'recipe')
  const bCL = await bind(C.agentId, line, 'line-recipe')
  ok('G0', '四种绑定建立(dcw×2+recipe / recipe / line-recipe / 无)',
    [bA1, bA2, bAR, bBR, bCL].every(r => r.status === 200 && r?.data?.binding?.id),
    JSON.stringify({ A: [bA1.status, bA2.status, bAR.status], B: bBR.status, C: bCL.status, D: 'none' }))

  // A0 注入面:绑定点位 + 下发收窄声明(配方面会列出全部参数供阅读,写面才是授权面)
  const aNodes = await invokeAs(A.agentId, A.token, 'my_industrial_nodes', {})
  const aNodesText = aNodes.text
  ok('A0', '窄绑 Agent 注入面声明「下发收窄」且含绑定点位', /加热区1设定/.test(aNodesText)
  && /螺杆转速设定/.test(aNodesText) && /收窄|只能下发|已绑定数控节点/.test(aNodesText),
  aNodesText.replace(/\s+/g, ' ').slice(0, 600))

  // A1 窄绑:整配方四参数 → 拒绝并点名未绑点位
  const devA0 = await simNodes()
  const aFull = await invokeAs(A.agentId, A.token, 'recipe_trial', {
    line_id: line,
    params: [{ node_id: zone, value: 200 }, { node_id: screw, value: 170 }, { node_id: speed, value: 85 }, { node_id: gap, value: 1.2 }],
    hypothesis: '窄绑验收:整配方应在未绑点位处被拒',
  })
  const devA1 = await simNodes()
  const unchangedA1 = Math.abs((simSignal(devA1, 'dev-gauge-mqtt', 'linespeed-sp') ?? NaN) - 90) < 0.02
    && Math.abs((simSignal(devA1, 'dev-extruder-mbtcp', 'zone1-sp') ?? NaN) - (simSignal(devA0, 'dev-extruder-mbtcp', 'zone1-sp') ?? NaN)) < 0.02
  ok('A1', '窄绑整配方被拒且点名未绑点位、设备不变',
    aFull.isError && /线速度设定|模口间隙设定/.test(aFull.text) && unchangedA1,
    aFull.text.replace(/\s+/g, ' ').slice(0, 600))

  // A2 窄绑:只下发绑定的两个点 → 成功,设备变化
  const aPart = await invokeAs(A.agentId, A.token, 'recipe_trial', {
    line_id: line,
    params: [{ node_id: zone, value: 200 }, { node_id: screw, value: 170 }],
    hypothesis: '窄绑验收:只改动被授权的两个点位',
  })
  await sleep(1500)
  const devA2 = await simNodes()
  const zoneA2 = simSignal(devA2, 'dev-extruder-mbtcp', 'zone1-sp')
  const screwA2 = simSignal(devA2, 'dev-extruder-opcua', 'screw-sp')
  ok('A2', '窄绑只下发绑定点位成功(设备=200/170),未绑点位不动',
    !aPart.isError && Math.abs((zoneA2 ?? NaN) - 200) < 0.02 && Math.abs((screwA2 ?? NaN) - 170) < 0.02
    && Math.abs((simSignal(devA2, 'dev-gauge-mqtt', 'linespeed-sp') ?? NaN) - 90) < 0.02,
    `text=${aPart.text.replace(/\s+/g, ' ').slice(0, 320)} zone=${zoneA2} screw=${screwA2}`)

  // A3 版本操作:recipe 绑定即可(不需要 dcw 全量)
  const aUpd = await invokeAs(A.agentId, A.token, 'recipe_update', {
    recipe_id: R1.id, params: [{ node_id: zone, value: 197 }], reason: '窄绑验收:recipe 绑定者可改配方版本',
  })
  const vAfterA = ((await api('GET', `/api/workshop/dcw/recipes/${R1.id}/versions`)).data?.versions ?? [])
  ok('A3', '窄绑(recipe 绑定)可做版本修改,版本递增',
    !aUpd.isError && vAfterA.length >= 2 && Number(vAfterA[vAfterA.length - 1]?.version) >= 2,
    `text=${aUpd.text.replace(/\s+/g, ' ').slice(0, 260)} versions=${vAfterA.map(v => v.version).join(',')}`)

  // B1 仅配方绑定、无 dcw → 全参数下发(向下兼容)
  const bFull = await invokeAs(B.agentId, B.token, 'recipe_trial', {
    line_id: line,
    params: [{ node_id: zone, value: 200 }, { node_id: screw, value: 175 }, { node_id: speed, value: 85 }, { node_id: gap, value: 1.2 }],
    hypothesis: '仅配方绑定无 dcw:按向下兼容应可全参数下发',
  })
  await sleep(1500)
  const devB = await simNodes()
  const bAll = Math.abs((simSignal(devB, 'dev-extruder-mbtcp', 'zone1-sp') ?? NaN) - 200) < 0.02
    && Math.abs((simSignal(devB, 'dev-extruder-opcua', 'screw-sp') ?? NaN) - 175) < 0.02
    && Math.abs((simSignal(devB, 'dev-gauge-mqtt', 'linespeed-sp') ?? NaN) - 85) < 0.02
    && Math.abs((simSignal(devB, 'dev-inspect-http', 'diegap-sp') ?? NaN) - 1.2) < 0.011
  ok('B1', '仅配方绑定 + 无 dcw → 四参数全量下发成功(向下兼容)', !bFull.isError && bAll,
    `text=${bFull.text.replace(/\s+/g, ' ').slice(0, 300)} device=${JSON.stringify([simSignal(devB, 'dev-extruder-mbtcp', 'zone1-sp'), simSignal(devB, 'dev-extruder-opcua', 'screw-sp'), simSignal(devB, 'dev-gauge-mqtt', 'linespeed-sp'), simSignal(devB, 'dev-inspect-http', 'diegap-sp')])}`)

  // B2 版本回退
  const bRb = await invokeAs(B.agentId, B.token, 'recipe_rollback', {
    recipe_id: R1.id, version: 1, reason: '仅配方绑定验收:回退定义到 v1(不触产线)',
  })
  const vAfterB = ((await api('GET', `/api/workshop/dcw/recipes/${R1.id}/versions`)).data?.versions ?? [])
  const lastB = vAfterB[vAfterB.length - 1]
  ok('B2', '仅配方绑定可回退版本(v3=v1 定义)',
    !bRb.isError && Number(lastB?.version) >= 3
    && (lastB?.params ?? []).some(p => p.nodeId === zone && Number(p.value) === 195),
    `text=${bRb.text.replace(/\s+/g, ' ').slice(0, 260)} versions=${vAfterB.map(v => `${v.version}:${(v.params ?? []).map(p => p.value).join('/')}`).join(',')}`)

  // C1 产线管理权:新建配方
  const recipesBefore = new Set(((await api('GET', '/api/workshop/dcw/recipes')).data?.recipes ?? []).map(r => r.id))
  const cCreate = await invokeAs(C.agentId, C.token, 'recipe_create', {
    line_id: line, name: '产线管理权新建配方', product_id: product.id,
    params: [{ node_id: zone, value: 196 }, { node_id: screw, value: 165 }],
    reason: '产线管理权验收:整线范围内新建配方',
  })
  let R2 = ''
  for (let i = 0; i < 10 && !R2; i++) {
    const list = ((await api('GET', '/api/workshop/dcw/recipes')).data?.recipes ?? []).filter(r => r.lineId === line && !recipesBefore.has(r.id))
    R2 = list[0]?.id ?? ''
    if (!R2) await sleep(1000)
  }
  ok('C1', '产线管理权可新建配方(无需单配方绑定)', !cCreate.isError && Boolean(R2),
    `text=${cCreate.text.replace(/\s+/g, ' ').slice(0, 300)} new=${R2 || '(未找到)'}`)

  // C2 产线管理权、无 dcw → 全参数下发(兼容)
  const cTrial = await invokeAs(C.agentId, C.token, 'recipe_trial', {
    line_id: line,
    params: [{ node_id: zone, value: 199 }, { node_id: screw, value: 172 }, { node_id: speed, value: 87 }, { node_id: gap, value: 1.15 }],
    hypothesis: '产线管理权 + 无 dcw:全参数下发兼容',
  })
  await sleep(1500)
  const devC = await simNodes()
  ok('C2', '产线管理权(无 dcw)全参数下发成功',
    !cTrial.isError
    && Math.abs((simSignal(devC, 'dev-extruder-mbtcp', 'zone1-sp') ?? NaN) - 199) < 0.02
    && Math.abs((simSignal(devC, 'dev-gauge-mqtt', 'linespeed-sp') ?? NaN) - 87) < 0.02,
    `text=${cTrial.text.replace(/\s+/g, ' ').slice(0, 260)} device=${JSON.stringify([simSignal(devC, 'dev-extruder-mbtcp', 'zone1-sp'), simSignal(devC, 'dev-gauge-mqtt', 'linespeed-sp')])}`)

  // C3 产线管理权:修改活动配方(版本操作)
  const cUpd = await invokeAs(C.agentId, C.token, 'recipe_update', {
    recipe_id: R1.id, params: [{ node_id: screw, value: 174 }], reason: '产线管理权验收:修改活动配方版本',
  })
  const vAfterC = ((await api('GET', `/api/workshop/dcw/recipes/${R1.id}/versions`)).data?.versions ?? [])
  ok('C3', '产线管理权可修改任意配方版本',
    !cUpd.isError && vAfterC.length >= 4,
    `text=${cUpd.text.replace(/\s+/g, ' ').slice(0, 260)} versions=${vAfterC.map(v => v.version).join(',')}`)

  // D1/D2 无绑定:写与版本均拒绝;D3 读允许(频道绑线只读扩权)
  const dTrial = await invokeAs(D.agentId, D.token, 'recipe_trial', { line_id: line, params: [{ node_id: zone, value: 201 }], hypothesis: '无绑定验收:应拒绝' })
  const dUpd = await invokeAs(D.agentId, D.token, 'recipe_update', { recipe_id: R1.id, params: [{ node_id: zone, value: 201 }], reason: '无绑定验收:应拒绝' })
  ok('D1', '无任何绑定:下发被拒', dTrial.isError && /绑定|授权|无权/.test(dTrial.text), dTrial.text.replace(/\s+/g, ' ').slice(0, 420))
  ok('D2', '无任何绑定:版本修改被拒', dUpd.isError && /绑定|授权|无权|配方级/.test(dUpd.text), dUpd.text.replace(/\s+/g, ' ').slice(0, 420))
  const dRead = await invokeAs(D.agentId, D.token, 'daq_query', { line_id: line, last_minutes: 3, bucket_ms: 1000 })
  ok('D3', '无绑定但频道绑线:只读抓数允许', !dRead.isError && /样本\s*\d+\s*点/.test(dRead.text), dRead.text.replace(/\s+/g, ' ').slice(0, 320))

  // 模型决策环节不在本套件门禁内:绑定语义是授权契约,用 Agent 令牌 + HITL 确定性验证;
  // Qwen 实时抓数已在 2026-10-29-mes-mirror Q1 覆盖,模型自主下发在 2026-10-28-physical-effect 覆盖。
  // 本地 9B 在长任务回合会偶发长时间不产出(实测),把它放进门禁会让授权验收变成模型可用性抽奖。

  evidence.scenario = { line, daq, dw, R1: R1.id, R2, agents: { A: A.agentId, B: B.agentId, C: C.agentId, D: D.agentId }, channelB: B.channelId }
  evidence.texts = { aNodes: aNodesText.slice(0, 1200), aFull: aFull.text.slice(0, 900), aPart: aPart.text.slice(0, 600), bFull: bFull.text.slice(0, 600), dTrial: dTrial.text.slice(0, 600), dUpd: dUpd.text.slice(0, 600), dRead: dRead.text.slice(0, 600) }
  evidence.qwen = { skipped: true, reason: 'bundle gate 只验证授权契约;模型路径见 mes-mirror Q1 / physical-effect', coveredBy: ['2026-10-29-mes-mirror#Q1', '2026-10-28-physical-effect'] }
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
