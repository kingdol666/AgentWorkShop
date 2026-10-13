#!/usr/bin/env node
/**
 * scripts/onboarding/sim-twin.mjs —— PLC 模拟器孪生生成器(aw-plc-sim-twin skill 的执行体)。
 *
 * 两种模式:
 *   A. 从平台既有节点反向构造孪生(最常用:虚拟预演/割接前演练):
 *      node scripts/onboarding/sim-twin.mjs --from-platform --line <lineId> [--sim-port 4034] \
 *        [--dynamics <dynamics.json>] [--shadow <dir>] [--keep-if-up]
 *      拉取该线全部 DCW(SV)+ DAQ(PV),按协议族归并成孪生设备写入模拟器:
 *      SV→manual(可写),PV→hook 一阶滞后跟随同名 SP(无 SP 则有界随机游走);
 *      --dynamics 可对指定 PV 覆盖因果(base/follows[{sp,gain}]/tau/noise)。
 *   B. 从文档蓝图直接构造(文档协议/API 输入输出已提炼成蓝图 JSON):
 *      node scripts/onboarding/sim-twin.mjs --blueprint <blueprint.json> [--sim-port 4034]
 *
 * 蓝图 JSON 形状(模式 B;devices[] 同模式 A 的内部设备模型):
 * { "simPort": 4034, "shadowDir": "..", "mqttPort": 41830?,
 *   "devices": [ { "id":"wb-machine", "name":"键合主机", "protocol":"modbus-tcp"|"modbus-rtu"|"mqtt",
 *                  "port": 37532?, "unitId": 1?,
 *                  "signals": [ { "id":"usPower-sp","name":"超声功率SP","unit":"%","min":20,"max":100,
 *                                 "decimals":0,"kind":"sp","initial":60 },
 *                               { "id":"pullForce-pv","name":"拉力强度","unit":"gf","min":0,"max":120,
 *                                 "decimals":2,"kind":"pv",
 *                                 "dynamics":{ "base":18,"tau":8,"noise":1.1,
 *                                              "follows":[{"sp":"超声功率SP","gain":0.55}] } } ] } ] }
 *
 * 输出(末行 JSON):{simBase, shadowDir, devices:[{id,protocol,port,signals}],
 *   driverSource:"sim-export", next:"对每设备 GET /api/nodes/:id/export 取 driverConfig 喂给 provision-line/onboard"}
 *
 * 纪律:本脚本只写模拟器(影子树),绝不写平台;平台侧接入走 onboard.mjs/provision-line.mjs。
 * 孪生协议归一:mes-rest/http/opcua 族节点映射到 modbus-tcp 孪生设备(语义/量程保留;
 *   协议真实性由 onboard 期的 export driverConfig 保证——模拟器 export 什么,平台就接什么)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const argOf = (k, d = '') => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const SIM_PORT = Number(argOf('--sim-port', '4034'))
const SIM = `http://127.0.0.1:${SIM_PORT}`
const SIM_DIR = resolve(argOf('--shadow', join(REPO, '..', `plc-node-simulator-twin-${SIM_PORT}`)))
const AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ── 平台 REST ── */
let TOKEN = process.env.AW_TOKEN ?? ''
async function platformLogin() {
  if (TOKEN) return
  const email = process.env.AW_EMAIL
  const passW = process.env.AW_PASS
  if (!email || !passW) throw new Error('未鉴权:设 AW_TOKEN 或 AW_EMAIL/AW_PASS')
  const r = await fetch(`${AW_BASE}/api/users/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: passW }), signal: AbortSignal.timeout(20000),
  })
  const j = await r.json()
  TOKEN = j?.data?.token ?? ''
  if (!TOKEN) throw new Error(`登录失败:${j?.message ?? r.status}`)
}
const platform = async (method, path) => {
  await platformLogin()
  const r = await fetch(AW_BASE + path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(60000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

/* ── 模拟器 REST(带就绪/HTML 容错) ── */
const simApi = async (method, path, body, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(SIM + path, {
        method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
      })
      if (!String(r.headers.get('content-type') ?? '').includes('json')) { await sleep(3000); continue }
      return await r.json()
    }
    catch (e) { if (i === tries - 1) return { code: -1, message: e.message }; await sleep(3000) }
  }
  return { code: -1, message: 'sim 未就绪' }
}

/* ── 模拟器保活(影子树复用 bench/lib/sim.mjs 的 spawn 纪律) ── */
async function ensureSim() {
  const psi = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${SIM_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
  const pid = Number(psi.stdout.trim())
  if (Number.isInteger(pid) && pid > 0 && !args.includes('--restart')) return
  if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1500)
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    const probe = await simApi('GET', '/api/nodes', undefined, 2)
    if (probe?.code === 0) ready = true
    else await sleep(2000)
  }
  if (!ready) throw new Error('模拟器路由未就绪(端口已开但 API 非 JSON)')
}

/* ── 信号动力学(hook 代码生成) ── */
const lagHook = (spName, tau, noise, fallback) =>
  `const tgt = Number.isFinite(vars['${spName}']) ? vars['${spName}'] : ${fallback};` +
  `const k = Math.min(1, dt/1000/${tau}); state.v = (Number.isFinite(state.v)?state.v:${fallback}) + (tgt-state.v)*k + (rand()-0.5)*${noise}; return state.v`
const causalHook = (d, fallback) => {
  const terms = (d.follows ?? []).map(f => `${f.gain}*(Number.isFinite(vars['${f.sp}'])?vars['${f.sp}']:0)`)
  const base = d.base ?? fallback
  return `const tgt = ${base}${terms.length ? ' + ' + terms.join(' + ') : ''};` +
    `const k = Math.min(1, dt/1000/${d.tau ?? 8}); state.v = (Number.isFinite(state.v)?state.v:${fallback}) + (tgt-state.v)*k + (rand()-0.5)*${d.noise ?? 1}; return state.v`
}
const wanderHook = (mid, span) =>
  `state.v = (Number.isFinite(state.v)?state.v:${mid}) + (rand()-0.5)*${span}; ` +
  `if (state.v > ${mid + span * 4}) state.v = ${mid + span * 4}; if (state.v < ${mid - span * 4}) state.v = ${mid - span * 4}; return state.v`

const norm = n => String(n).replace(/(PV|实测|实际|回读|-回读|值)$/g, '').trim()

/* ── 模式 A:平台节点 → 孪生设备 ── */
async function fromPlatform(lineId, dynamicsFile) {
  const dyn = dynamicsFile && existsSync(dynamicsFile) ? JSON.parse(readFileSync(dynamicsFile, 'utf8')) : {}
  const dcw = (await platform('GET', '/api/workshop/dcw?limit=200'))?.data?.nodes?.filter(n => n.lineId === lineId) ?? []
  const daq = (await platform('GET', '/api/workshop/daq?limit=300'))?.data?.nodes?.filter(n => n.lineId === lineId) ?? []
  if (!dcw.length && !daq.length) throw new Error(`线 ${lineId} 无节点(dcw=${dcw.length} daq=${daq.length})`)
  // 协议族归并(mes-rest/http/opcua → modbus-tcp 孪生;语义/量程保留)
  const fam = n => (['modbus-tcp', 'modbus-rtu', 'mqtt'].includes(n.driver) ? n.driver : 'modbus-tcp')
  const families = {}
  for (const n of [...dcw, ...daq]) (families[fam(n)] ??= []).push(n)
  let port = 37540
  const devices = []
  const svNamesByFam = {}
  for (const [family, nodes] of Object.entries(families)) {
    const spNames = nodes.filter(n => n.templateRef?.startsWith('dcw') || dcw.some(d => d.id === n.id)).map(n => norm(n.name))
    svNamesByFam[family] = spNames
    const signals = []
    for (const n of nodes) {
      const isSp = dcw.some(d => d.id === n.id)
      const min = Number(n.min ?? 0), max = Number(n.max ?? 100)
      const mid = Number(((min + max) / 2).toFixed(3))
      if (isSp) {
        signals.push({ id: n.id, name: n.name, unit: n.unit ?? '', min, max, decimals: n.decimals ?? 2, kind: 'sp', initial: Number(n.value ?? mid) })
      } else {
        const d = dyn[n.name] ?? {}
        // 同设备同名 SP 归属:strip 后缀匹配
        const spHit = spNames.find(sp => sp === norm(n.name))
        let code
        if (d.follows?.length || d.base != null) code = causalHook(d, mid)
        else if (spHit) code = lagHook(spHit, d.tau ?? 10, d.noise ?? 0.8, mid)
        else code = wanderHook(mid, Math.max((max - min) / 200, 0.2))
        signals.push({ id: n.id, name: n.name, unit: n.unit ?? '', min, max, decimals: n.decimals ?? 3, kind: 'pv', code, dynamics: { tau: d.tau ?? 10, noise: d.noise ?? 0.8, sp: spHit ?? null } })
      }
    }
    devices.push({ family, nodes, signals })
  }
  return { devices }
}

/* ── 蓝图 → 设备(模式 B 归一到同一内部模型) ── */
function fromBlueprint(file) {
  const bp = JSON.parse(readFileSync(file, 'utf8'))
  const devices = (bp.devices ?? []).map(d => ({
    family: d.protocol ?? 'modbus-tcp',
    port: d.port,
    unitId: d.unitId ?? 1,
    mqtt: d.mqtt,
    signals: (d.signals ?? []).map(s => ({
      id: s.id, name: s.name, unit: s.unit ?? '', min: Number(s.min ?? 0), max: Number(s.max ?? 100),
      decimals: s.decimals ?? 2, kind: s.kind ?? (String(s.id).endsWith('-sp') ? 'sp' : 'pv'),
      initial: s.initial, code: s.code, dynamics: s.dynamics ?? {},
    })),
  }))
  return { devices, mqttPort: bp.mqttPort }
}

/* ── 设备写入模拟器 ── */
let port = 37540
async function materialize(devices, mqttPort) {
  const created = []
  for (const dev of devices) {
    const id = `twin-${dev.family}-${created.length + 1}`
    const protocol = dev.family
    const config = {}
    if (protocol === 'modbus-tcp' || protocol === 'modbus-rtu') {
      config.host = '0.0.0.0'
      config.port = dev.port ?? (port += 2)
      config.unitId = dev.unitId ?? 1
      config.registerMaps = dev.signals.map((s, i) => ({ address: 40001 + i * 2, area: 'holding', signalId: s.id, dataType: 'float32', byteOrder: 'big' }))
    } else if (protocol === 'mqtt') {
      config.brokerUrl = `mqtt://127.0.0.1:${mqttPort}`
      config.topics = dev.signals.filter(s => s.kind === 'pv').map(s => ({ topic: `aw/twin/${id}/${s.id}`, signalId: s.id, payloadTemplate: `{"data":{"${s.id}":\${value}}}`, qos: 0 }))
      const sp = dev.signals.find(s => s.kind === 'sp')
      if (sp) { config.commandTopic = `aw/twin/${id}/set`; config.commandSignalId = sp.id }
    }
    const signals = dev.signals.map(s => ({
      id: s.id, name: s.name, description: `孪生:${s.name}`, unit: s.unit, min: s.min, max: s.max, decimals: s.decimals,
      strategy: s.kind === 'sp'
        ? { kind: 'manual', value: s.initial ?? (s.min + s.max) / 2 }
        : { kind: 'hook', code: s.code ?? wanderHook((s.min + s.max) / 2, Math.max((s.max - s.min) / 200, 0.2)) },
    }))
    const r = await simApi('POST', '/api/nodes', { id, name: `${id}(孪生)`, description: `aw-plc-sim-twin 生成:${dev.signals.length} 信号`, protocol, enabled: true, tickMs: 1000, signals, config })
    ok(`设备 ${id}(${protocol},${signals.length} 信号)`, r?.code === 0, r?.message ?? '')
    created.push({ id, protocol, port: config.port ?? null, signals: signals.length, sourceNodes: dev.nodes?.map(n => n.id) ?? null })
  }
  return created
}

/* ── 孪生活性自检(PV 应随时间波动) ── */
async function livenessCheck() {
  await sleep(8000)
  const a = await simApi('GET', '/api/nodes')
  const devs = (a?.data ?? []).filter(n => String(n.id).startsWith('twin-'))
  const snap = devs.map(n => ({ id: n.id, v: (n.signals ?? []).map(s => s.value) }))
  await sleep(6000)
  const b = await simApi('GET', '/api/nodes')
  const devs2 = (b?.data ?? []).filter(n => String(n.id).startsWith('twin-'))
  let moved = 0; const dead = []
  for (const d2 of devs2) {
    const before = snap.find(x => x.id === d2.id)
    const pv = (d2.signals ?? []).filter(s => s.strategy?.kind === 'hook' || s.strategy?.kind === 'expression')
    const changed = pv.some((s, i) => Number(s.value) !== Number(before?.v?.[before.v.length - pv.length + i]))
    if (changed) moved++
    else dead.push(d2.id)
  }
  ok(`孪生 tick 活性(${moved}/${devs2.length} 设备 PV 在动)`, moved === devs2.length && devs2.length > 0, dead.length ? `冻结:${dead.join(',')} — 处方:整树重启模拟器(POST 不可修)` : '')
  return { devices: devs2.length, signals: devs2.reduce((a, n) => a + (n.signals ?? []).length, 0) }
}

/* ── 主流程 ── */
console.log(`[sim-twin] 模拟器 :${SIM_PORT} 影子树 ${SIM_DIR}`)
await ensureSim()
let created, liveness
if (args.includes('--from-platform')) {
  const lineId = argOf('--line')
  if (!lineId) { console.error('用法:--from-platform 需要 --line <lineId>'); process.exit(1) }
  console.log(`[sim-twin] 从平台线 ${lineId} 反向构造孪生…`)
  const { devices } = await fromPlatform(lineId, argOf('--dynamics'))
  console.log(`  协议族归并:${devices.map(d => `${d.family}×${d.signals.length}`).join(' + ')}`)
  created = await materialize(devices, Number(argOf('--mqtt-port', String(18830 + (SIM_PORT - 4010) * 1000))))
} else if (args.includes('--blueprint')) {
  const bpFile = argOf('--blueprint')
  if (!bpFile || !existsSync(bpFile)) { console.error('用法:--blueprint <file.json>'); process.exit(1) }
  const { devices, mqttPort } = fromBlueprint(bpFile)
  created = await materialize(devices, Number(argOf('--mqtt-port', mqttPort ?? String(18830 + (SIM_PORT - 4010) * 1000))))
} else {
  console.error('用法:sim-twin.mjs --from-platform --line <id> | --blueprint <file> [--sim-port 4034] [--dynamics file]')
  process.exit(1)
}
liveness = await livenessCheck()
console.log('')
console.log('════════════════════════════════════════')
console.log(`  sim-twin:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
const summary = {
  simBase: SIM, shadowDir: SIM_DIR, devices: created, totalSignals: liveness.signals,
  driverSource: 'sim-export',
  next: `对每设备 GET ${SIM}/api/nodes/<id>/export 取 items[].driverConfig,喂给 provision-line/onboard(driverConfig 替换为模拟器 export,量程/stepLimit 保留)`,
}
console.log(JSON.stringify(summary))
if (fails.length) process.exit(1)
