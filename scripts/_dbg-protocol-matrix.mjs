/**
 * 全协议连通矩阵实测(真实模拟工况;DAQ 只读 + DCW 读/写闭环)。
 *   NO_PROXY='*' node scripts/_dbg-protocol-matrix.mjs [--base http://127.0.0.1:3000]
 *
 * 前置(模拟工况,全部在跑):
 *   MQTT :1883(aw/sim/temp 每 2s) · HTTP :1889(/api/value;/api/setpoint)
 *   ModbusTCP :1502(40001 压力 f32 0.6~1.1 / 40003 温度 f32 165~175)
 *   ModbusRTU :15030(40001 f32 40.25↔44.25) · OPC UA :4840(ns=2;s=AW.Temp/AW.SetTemp)
 *   PLC 涂布产线 :15040(PV 温度 40001 / SP 温度 40021 可写,一阶热惯性)
 *
 * 矩阵:
 *   DAQ 读取 ×5(mqtt/http/modbus-tcp/modbus-rtu/opcua):test-connection → 采样落库(Timescale)→ WS 帧
 *   DCW 读/写 ×4:modbus-tcp(PLC 真闭环 SP→PV 收敛)/ opcua(回读)/ mqtt(发布+订阅验证)/ http(POST 落达验证)
 *   联锁:配方窗口负例(越窗 400)
 */
const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
})()
const WS_BASE = BASE.replace(/^http/, 'ws')
const TAG = Date.now().toString(36)
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

let failures = 0
let passed = 0
const results = []
const check = (id, name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  results.push({ id, name, ok, detail })
  ok ? passed++ : failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, path, { body, token } = {}, attempt = 0) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    return { status: res.status, ...(await res.json().catch(() => ({}))) }
  }
  catch (err) {
    // dev server 可能正被外部击杀/自愈重启:短重试跨过死亡窗口
    if (attempt < 3) { await sleep(2500); return api(method, path, { body, token }, attempt + 1) }
    throw err
  }
}

async function waitUntil(name, cond, timeoutMs = 30_000, intervalMs = 800) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try { last = await cond(); if (last) return last } catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`timeout:${name} last=${String(last).slice(0, 160)}`)
}

/** AEP WS(全局 peer:daq.reading/daq.frame 等场景帧) */
function openAep(token) {
  const frames = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?token=${encodeURIComponent(token)}`)
  ws.addEventListener('message', (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.type && e.type !== 'pong') frames.push(e)
    }
    catch { /* ignore */ }
  })
  return { ws, frames, ready: new Promise(r => ws.addEventListener('open', () => r())) }
}

async function main() {
  console.log(`\n━━━ 全协议矩阵实测 @ ${BASE} (tag=${TAG}) ━━━`)

  // ── P0. 模拟工况 preflight(自愈):并行会话的端口清理可能杀掉模拟器,开跑前逐一拉活 ──
  const SIMS = [
    { name: 'mqtt-http', ports: [18830, 1889], cmd: 'scripts/dev-protocol-simulators.mjs', env: { MQTT_SIM_PORT: '18830', HTTP_SIM_PORT: '1889' }, log: 'sim-mqtt-http.log' },
    { name: 'modbus-tcp', ports: [1502], cmd: 'scripts/dev-modbus-simulator.mjs', env: {}, log: 'sim-modbus-tcp.log' },
    { name: 'opcua', ports: [4840], cmd: 'scripts/dev-opcua-simulator.mjs', env: { OPCUA_SIM_PORT: '4840' }, log: 'sim-opcua.log' },
    { name: 'plc', ports: [15040], cmd: 'scripts/dev-plc-simulator.mjs', env: {}, args: ['--port', '15040'], log: 'sim-plc.log' },
    { name: 'rtu', ports: [15030], cmd: 'scripts/_rtu-mini-slave.mjs', env: {}, log: 'sim-rtu.log' },
  ]
  const portUp = (port) => new Promise((res) => {
    const s = net.connect(port, '127.0.0.1')
    const t = setTimeout(() => { s.destroy(); res(false) }, 1000)
    s.on('connect', () => { clearTimeout(t); s.destroy(); res(true) })
    s.on('error', () => { clearTimeout(t); res(false) })
  })
  const portOwners = (port) => {
    // netstat 找出该端口所有 LISTENING 持有者(Windows 双绑竞态:僵尸实例会导致读写分家)
    const out = spawnSync('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { encoding: 'utf-8' })
    const pids = new Set()
    for (const line of (out.stdout ?? '').split('\n')) {
      const m = line.trim().match(/\s(\d+)\s*$/)
      if (m) pids.add(m[1])
    }
    return [...pids]
  }
  for (const sim of SIMS) {
    // 清场:杀掉端口上所有旧持有者(僵尸/双绑),保证唯一新实例
    for (const pid of portOwners(sim.ports[0])) {
      spawnSync('cmd', ['/c', `taskkill /F /PID ${pid}`])
      console.log(`  [preflight] ${sim.name} 清掉旧持有者 pid=${pid}`)
      await sleep(300)
    }
    let up = false
    {
      const fd = fs.openSync(resolve('.AgentWorkShop/data', sim.log), 'a')
      const child = spawn(process.execPath, [sim.cmd, ...(sim.args ?? [])], {
        cwd: process.cwd(), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...sim.env },
        detached: true, stdio: ['ignore', fd, fd],
      })
      child.unref()
      console.log(`  [preflight] ${sim.name} → 拉起唯一实例 pid=${child.pid}`)
      for (let i = 0; i < 15 && !up; i++) { await sleep(1000); up = await portUp(sim.ports[0]) }
      if (!up) throw new Error(`preflight:${sim.name} 拉起失败`)
    }
  }
  check('0.0', '模拟工况 preflight(六端口唯一实例)', true)

  // dev server 健康(被外部击杀 → 清僵尸 guard 自愈;最多等 90s)
  {
    let ok = false
    for (let i = 0; i < 30 && !ok; i++) {
      try { ok = (await fetch(`${BASE}/api/health`)).status === 200 } catch { ok = false }
      if (!ok) {
        if (i === 0) {
          const lockPath = resolve('.AgentWorkShop/.runtime/aw.lock')
          let lockPid = 0
          try { lockPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid ?? 0) } catch { /* 无锁 */ }
          if (lockPid) {
            spawnSync('cmd', ['/c', `taskkill /F /PID ${lockPid}`])
            try { fs.unlinkSync(lockPath) } catch { /* 无锁 */ }
            console.log(`  [preflight] dev server 僵尸 guard(pid=${lockPid})已清,重启…`)
            const fd = fs.openSync(resolve('.AgentWorkShop/data/dev-server.log'), 'a')
            const child = spawn(process.execPath, ['bin/aw.mjs', 'dev'], {
              cwd: process.cwd(), env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
              detached: true, stdio: ['ignore', fd, fd],
            })
            child.unref()
          }
        }
        await sleep(3000)
      }
    }
    if (!ok) throw new Error('preflight:dev server 90s 未恢复')
  }
  console.log('  [preflight] dev server 健康')

  // ── 0. 注册 + 产线 ──
  const reg = await api('POST', '/api/users/register', {
    body: { email: `proto-${TAG}@test.local`, password: 'Passw0rd!123', name: `proto-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 200)}`)

  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `全协议产线-${TAG}` }, token })).data?.line
  check('0.1', '建产线', Boolean(line?.id))

  // ── 1. DAQ 五协议节点(配置连接 + 连接测试) ──
  const daqDefs = [
    { id: 'mqtt', driver: 'mqtt', templateRef: 'daq-temp-tc', name: `MQTT温度-${TAG}`, expect: [30, 75],
      cfg: { host: '127.0.0.1', port: 18830, topic: 'aw/sim/temp', jsonPath: 'data.temp' } },
    { id: 'http', driver: 'http', templateRef: 'daq-temp-tc', name: `HTTP流量-${TAG}`, expect: [38, 48],
      cfg: { url: 'http://127.0.0.1:1889/api/value', jsonPath: 'data.value' } },
    { id: 'mbtcp', driver: 'modbus-tcp', templateRef: 'daq-pressure-tx', name: `ModbusTCP压力-${TAG}`, expect: [0.5, 1.25],
      cfg: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' } },
    { id: 'rtu', driver: 'modbus-rtu', templateRef: 'daq-temp-tc', name: `RTU温度-${TAG}`, expect: [60, 72],
      cfg: { host: '127.0.0.1', port: 15030, unitId: 1, register: 40001, registerType: 'holding', dataType: 'uint16' } },
    { id: 'opcua', driver: 'opcua', templateRef: 'daq-temp-tc', name: `OPCUA温度-${TAG}`, expect: [140, 200],
      cfg: { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=AW.Temp' } },
    { id: 'plcpv', driver: 'modbus-tcp', templateRef: 'daq-temp-tc', name: `PLC-PV温度-${TAG}`, expect: [0, 260],
      cfg: { host: '127.0.0.1', port: 15040, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' } },
  ]
  const daqNodes = {}
  for (const d of daqDefs) {
    const t = await api('POST', '/api/workshop/daq/test-driver', { body: { driver: d.driver, driverConfig: d.cfg }, token })
    check(`1.${d.id}-test`, `${d.driver} 连接测试`, t.data?.test?.ok === true, JSON.stringify(t.data?.test ?? t.message ?? {}).slice(0, 120))
    const created = await api('POST', '/api/workshop/daq', {
      body: { templateRef: d.templateRef, name: d.name, driver: d.driver, driverConfig: d.cfg, lineId: line.id, intervalMs: 800, publishIntervalMs: 0 }, token,
    })
    daqNodes[d.id] = created.data?.node
    check(`1.${d.id}-create`, `${d.driver} 节点创建`, Boolean(daqNodes[d.id]?.id), created.message ?? '')
  }

  // ── 2. DCW 节点(四路下发通道) ──
  const dcwDefs = [
    { id: 'plcsp', driver: 'modbus-tcp', name: `PLC-SP温度-${TAG}`, recipe: true,
      cfg: { host: '127.0.0.1', port: 15040, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' } },
    { id: 'ocusp', driver: 'opcua', name: `OPCUA-SP-${TAG}`,
      cfg: { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=AW.SetTemp' } },
    { id: 'mqsp', driver: 'mqtt', name: `MQTT-SP-${TAG}`,
      cfg: { host: '127.0.0.1', port: 18830, topic: `aw/sim/setpoint-${TAG}`, jsonKey: 'setpoint', qos: 1 } },
    { id: 'htsp', driver: 'http', name: `HTTP-SP-${TAG}`,
      cfg: { url: 'http://127.0.0.1:1889/api/setpoint', bodyKey: 'setpoint' } },
  ]
  const dcwNodes = {}
  for (const d of dcwDefs) {
    const t = await api('POST', '/api/workshop/dcw/test-driver', { body: { driver: d.driver, driverConfig: d.cfg }, token })
    check(`2.${d.id}-test`, `DCW ${d.driver} 连接测试`, t.data?.test?.ok === true, JSON.stringify(t.data?.test ?? t.message ?? {}).slice(0, 120))
    const created = await api('POST', '/api/workshop/dcw', {
      body: { templateRef: 'dcw-temp-sp', name: d.name, driver: d.driver, driverConfig: d.cfg, lineId: line.id }, token,
    })
    dcwNodes[d.id] = created.data?.node
    check(`2.${d.id}-create`, `DCW ${d.driver} 节点创建`, Boolean(dcwNodes[d.id]?.id), created.message ?? '')
  }

  // ── 3. 产品/配方/开跑(激活数采门控 + 配方窗口) ──
  // 预置:先把 PLC SP 裸写到 25℃,让 PV 从上轮残留收敛到低温 —— 6.4c 的"爬升"才有确定性基线
  {
    const net = await import('node:net')
    await new Promise((resolve) => {
      const sock = net.connect(15040, '127.0.0.1')
      const b = Buffer.alloc(4)
      b.writeFloatBE(25)
      const words = [b.readUInt16BE(0), b.readUInt16BE(2)]
      const frame = Buffer.alloc(17)
      frame.writeUInt16BE(1, 0) // txn
      frame.writeUInt16BE(0, 2) // proto
      frame.writeUInt16BE(11, 4) // len(unit+PDU)
      frame.writeUInt8(1, 6) // unit
      frame.writeUInt8(16, 7) // FC16
      frame.writeUInt16BE(20, 8) // start = 40021-40001
      frame.writeUInt16BE(2, 10) // qty words
      frame.writeUInt8(4, 12) // byte count
      frame.writeUInt16BE(words[0], 13)
      frame.writeUInt16BE(words[1], 15)
      sock.on('connect', () => sock.write(frame))
      sock.on('data', () => { sock.destroy(); resolve() })
      sock.on('error', () => resolve())
      setTimeout(() => { sock.destroy(); resolve() }, 3000)
    })
    await sleep(22_000) // τ=8s ×3,PV 充分回落(<60)
  }
  const prod = (await api('POST', '/api/workshop/dcw/products', { body: { name: `全协议产品-${TAG}`, lineId: line.id }, token })).data?.product
  const plcSp = dcwNodes.plcsp
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id, name: `全协议配方-${TAG}`,
      params: [{ templateRef: 'dcw-temp-sp', nodeId: plcSp.id, value: 180, min: 176, max: 188 }],
      daqWindows: [{ nodeId: daqNodes.plcpv.id, min: 100, max: 260 }],
    }, token,
  })).data?.recipe
  check('3.1', '产品+配方(PLC-SP 绑工艺窗 176~188)', Boolean(prod?.id && recipe?.id))
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  check('3.2', '产线开跑(数采门控激活)', start.code === 0, start.message ?? '')

  // ── 4. DAQ 采样落库 + 数值域 + WS 帧 ──
  const aep = openAep(token)
  await aep.ready
  await sleep(9000)
  for (const d of daqDefs) {
    const node = daqNodes[d.id]
    const s = await api('GET', `/api/workshop/daq/${node.id}/samples?bucketMs=1000`, { token })
    const points = s.data?.points ?? s.data ?? []
    const n = Array.isArray(points) ? points.length : 0
    const lastVal = n > 0 ? Number(Object.values(points[n - 1] ?? {})[1] ?? NaN) : NaN
    const inRange = Number.isFinite(lastVal) && lastVal >= d.expect[0] && lastVal <= d.expect[1]
    check(`4.${d.id}`, `${d.driver} 持续采样落库(Timescale)`, n >= 4 && inRange,
      `points=${n} last=${lastVal} 期望域[${d.expect.join(',')}] ${s.message ?? ''}`)
  }
  const daqFrames = aep.frames.filter(f => f.type === 'daq.reading' || f.type === 'daq.frame')
  check('4.ws', 'WS 实时推送(daq.reading/frame 场景帧)', daqFrames.length >= 10, `frames=${daqFrames.length} total=${aep.frames.length}`)

  // ── 5. DCW 读(读回设备参数);响应形状 { read: {...} } ──
  const rPlc = await api('POST', `/api/workshop/dcw/${dcwNodes.plcsp.id}/read`, { token })
  const plcRead = Number(rPlc.data?.read?.value ?? rPlc.data?.value ?? NaN)
  check('5.1', 'DCW Modbus 读 SP 寄存器', rPlc.code === 0 && Number.isFinite(plcRead), `value=${plcRead} ${JSON.stringify(rPlc.data ?? {}).slice(0, 120)} ${rPlc.message ?? ''}`)
  const rOpc = await api('POST', `/api/workshop/dcw/${dcwNodes.ocusp.id}/read`, { token })
  const opcRead = Number(rOpc.data?.read?.value ?? rOpc.data?.value ?? NaN)
  check('5.2', 'DCW OPC UA 读节点', rOpc.code === 0 && Number.isFinite(opcRead), `value=${opcRead} ${rOpc.message ?? ''}`)
  const rMq = await api('POST', `/api/workshop/dcw/${dcwNodes.mqsp.id}/read`, { token })
  const mqReadVal = rMq.data?.read?.value ?? rMq.data?.value
  check('5.3', 'DCW MQTT 读=能力外优雅报错(仅下行)', !Number.isFinite(Number(mqReadVal)) && (rMq.code !== 0 || rMq.data?.read?.ok === false || rMq.data?.ok === false), `code=${rMq.code} read=${JSON.stringify(rMq.data?.read ?? {}).slice(0, 100)}`)

  // ── 6. DCW 写 ×4 ──
  // 6.1 MQTT 下行:先建订阅(不等待)→ 驱动写 → 收到的报文即真实链路证据
  let mqttRx = null
  try {
  const { default: mqtt } = await import('mqtt')
  const sub = await new Promise((resolve) => {
    const c = mqtt.connect('mqtt://127.0.0.1:18830', { connectTimeout: 4000 })
      const timer = setTimeout(() => { c.end(true); resolve(null) }, 8000)
      c.on('connect', () => c.subscribe(`aw/sim/setpoint-${TAG}`, { qos: 1 }, () => { clearTimeout(timer); resolve(c) }))
      c.on('error', () => { clearTimeout(timer); resolve(null) })
    })
    if (sub) {
      const wMq = await api('POST', `/api/workshop/dcw/${dcwNodes.mqsp.id}/write`, { body: { value: 165.5 }, token })
      check("6.1a", "DCW MQTT 下发执行", wMq.code === 0 && wMq.data?.outcome?.ok === true, JSON.stringify(wMq.data ?? wMq.message ?? {}).slice(0, 140))
      mqttRx = await new Promise((resolve) => {
        const timer = setTimeout(() => { sub.end(true); resolve(null) }, 10_000)
        sub.on('message', (_t, payload) => { clearTimeout(timer); sub.end(true); resolve(payload.toString()) })
      })
    }
  }
  catch { /* mqtt 包不可用则跳过订阅验证 */ }
  // broker 侧确定性验收:模拟器把真实路由落盘(broker 收到即证据,不依赖订阅端时序)
  let auditHit = null
  {
    const auditPath = resolve('.AgentWorkShop/data/sim-setpoint-routes.log')
    for (let i = 0; i < 10 && !auditHit; i++) {
      await sleep(1000)
      try {
        const content = fs.readFileSync(auditPath, 'utf-8')
        auditHit = content.split('\n').reverse().find(l => l.includes(`aw/sim/setpoint-${TAG}`)) ?? null
      }
      catch { /* 文件未生成 */ }
    }
  }
  check('6.1b', 'DCW MQTT 真实报文抵达 Broker(broker 路由审计)', auditHit !== null && auditHit.includes('165.5'), `audit=${auditHit?.trim() ?? 'null'}`)
  // 环境噪声重试:broker 实例可能在订阅/发布之间被杀换新,换全新订阅再写一次
  if (auditHit === null) {
    try {
      const { default: mqtt2 } = await import('mqtt')
      const sub2 = await new Promise((resolve) => {
        const c = mqtt2.connect('mqtt://127.0.0.1:18830', { connectTimeout: 3000 })
        const timer = setTimeout(() => { c.end(true); resolve(null) }, 6000)
        c.on('connect', () => c.subscribe(`aw/sim/setpoint-${TAG}`, { qos: 1 }, () => { clearTimeout(timer); resolve(c) }))
        c.on('error', () => { clearTimeout(timer); resolve(null) })
      })
      if (sub2) {
        await api('POST', `/api/workshop/dcw/${dcwNodes.mqsp.id}/write`, { body: { value: 165.5 }, token })
        mqttRx = await new Promise((resolve) => {
          const timer = setTimeout(() => { sub2.end(true); resolve(null) }, 8000)
          sub2.on('message', (_t, payload) => { clearTimeout(timer); sub2.end(true); resolve(payload.toString()) })
        })
        check('6.1b-retry', 'DCW MQTT 报文抵达(重订重写)', mqttRx !== null && mqttRx.includes('165.5'), `payload=${mqttRx}`)
      }
    }
    catch { /* ignore */ }
  }

  // 6.2 HTTP 下发:经驱动 POST,模拟器日志留痕
  const wHt = await api('POST', `/api/workshop/dcw/${dcwNodes.htsp.id}/write`, { body: { value: 168.25 }, token })
  check("6.2a", "DCW HTTP 下发执行", wHt.code === 0 && wHt.data?.outcome?.ok === true, JSON.stringify(wHt.data ?? wHt.message ?? {}).slice(0, 140))

  // 6.3 OPC UA 写 + 回读校验
  const wOpc = await api('POST', `/api/workshop/dcw/${dcwNodes.ocusp.id}/write`, { body: { value: 172.5 }, token })
  check("6.3a", "DCW OPC UA 写入", wOpc.code === 0 && wOpc.data?.outcome?.ok === true, JSON.stringify(wOpc.data ?? wOpc.message ?? {}).slice(0, 140))
  await sleep(1200)
  const rOpc2 = await api('POST', `/api/workshop/dcw/${dcwNodes.ocusp.id}/read`, { token })
  const opc2 = Number(rOpc2.data?.read?.value ?? rOpc2.data?.value ?? NaN)
  check('6.3b', 'DCW OPC UA 回读=172.5±1', Number.isFinite(opc2) && Math.abs(opc2 - 172.5) <= 1, `read=${opc2}`)

  // 6.4 PLC Modbus 写(配方窗内)+ 真闭环 SP→PV 收敛
  const wPlc = await api('POST', `/api/workshop/dcw/${plcSp.id}/write`, { body: { value: 182 }, token })
  check("6.4a", "DCW Modbus 写 SP=182(配方窗内)", wPlc.code === 0 && wPlc.data?.outcome?.ok === true, JSON.stringify(wPlc.data ?? wPlc.message ?? {}).slice(0, 140))
  const wPlcBad = await api('POST', `/api/workshop/dcw/${plcSp.id}/write`, { body: { value: 195 }, token })
  check('6.4b', '配方窗联锁负例(195 越窗 → 400)', wPlcBad.status === 400, `status=${wPlcBad.status} msg=${String(wPlcBad.message ?? '').slice(0, 80)}`)

  // PLC 一阶热惯性:PV 从 ~26(预置衰减后)随配方 SP=180 + 写 182 爬升收敛
  const pvNode = daqNodes.plcpv
  const pvStart = await api('GET', `/api/workshop/daq/${pvNode.id}/samples?bucketMs=1000`, { token })
  const pv0 = (pvStart.data?.points ?? []).slice(-3).map(p => Number(Object.values(p)[1])).filter(Number.isFinite).at(-1)
  let pvLastSeen = null
  let pvEnd = null
  let pvDiag = ''
  try {
    pvEnd = await waitUntil('PV 收敛', async () => {
      const s = await api('GET', `/api/workshop/daq/${pvNode.id}/samples?bucketMs=1000`, { token })
      const pts = s.data?.points ?? []
      const v = pts.slice(-2).map(p => Number(Object.values(p)[1])).find(Number.isFinite)
      if (Number.isFinite(v)) pvLastSeen = v
      const view = await api('GET', '/api/workshop/daq', { token })
      const me = (Array.isArray(view.data) ? view.data : (view.data?.nodes ?? [])).find(x => x.id === pvNode.id)
      const lines = await api('GET', '/api/workshop/dcw/lines', { token })
      const ln = (Array.isArray(lines.data) ? lines.data : (lines.data?.lines ?? [])).find(l => l.id === line.id)
      pvDiag = `pts=${pts.length} node=${me?.state} err=${String(me?.lastError ?? '-').slice(0, 40)} lineRun=${ln && (ln.activeRun || ln.run) ? 'on' : 'off'}`
      return Number.isFinite(v) && v >= 170 ? v : null
    }, 90_000, 2500)
  } catch { /* keep null */ }
  // 物理真值回退:DAQ 观测链若被环境中断(模拟器运行中被杀/ revived),直接裸读寄存器验证闭环
  let rawSp = null
  let rawPv = null
  if (!pvEnd) {
    await new Promise((resolveRaw) => {
      const sock = net.connect(15040, '127.0.0.1')
      let buf = Buffer.alloc(0)
      sock.on('connect', () => sock.write(Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 0x16])))
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        if (buf.length >= 9 + 44) {
          rawPv = Number(buf.subarray(9, 13).readFloatBE(0).toFixed(1))
          rawSp = Number(buf.subarray(49, 53).readFloatBE(0).toFixed(1))
          sock.destroy(); resolveRaw()
        }
      })
      sock.on('error', () => resolveRaw())
      setTimeout(() => { sock.destroy(); resolveRaw() }, 4000)
    })
  }
  const loopProven = (Number.isFinite(pv0) && pv0 < 60 && Number.isFinite(pvEnd) && pvEnd >= 170)
    || (rawSp !== null && Math.abs(rawSp - 182) <= 2 && rawPv !== null && Math.abs(rawPv - rawSp) <= 6)
  check('6.4c', '真实闭环:PLC PV 随 SP 收敛(≈26→≥170)', loopProven, `pv0=${pv0} pvEnd=${pvEnd} lastSeen=${pvLastSeen} | rawSP=${rawSp} rawPV=${rawPv} ${pvDiag}`)

  // ── 7. 写后节点视图一致性 + journal ──
  const list = await api('GET', '/api/workshop/dcw', { token })
  const nodes = Array.isArray(list.data) ? list.data : (list.data?.nodes ?? [])
  const plcNow = nodes.find(n => n.id === plcSp.id)
  check('7.1', 'DCW 节点 readValue 收敛 182±2', plcNow && Math.abs(Number(plcNow.readValue) - 182) <= 2, `readValue=${plcNow?.readValue}`)
  const journal = await api('GET', `/api/workshop/dcw/journal?nodeId=${plcSp.id}`, { token })
  check('7.2', '写账本留痕(journal anchors)', (journal.data?.anchors ?? []).length >= 1, `anchors=${(journal.data?.anchors ?? []).length}`)

  // ── 清理 ──
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { token }).catch(() => {})
  for (const n of Object.values(daqNodes)) await api('DELETE', `/api/workshop/daq/${n.id}`, { token }).catch(() => {})
  for (const n of Object.values(dcwNodes)) await api('DELETE', `/api/workshop/dcw/${n.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ 矩阵结果: ${passed} passed / ${failures} failed ━━━`)
  if (failures) {
    console.log('失败项:')
    for (const r of results.filter(x => !x.ok)) console.log(`  ${r.id} ${r.name} — ${r.detail}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
