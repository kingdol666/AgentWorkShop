/**
 * PLC 真实场景端到端(数采 × 数控闭环;HTTP 面,打真实 dev server):
 * 自管 PLC 工艺模拟器(dev-plc-simulator,15040)→
 *   ①数采节点(温度PV 40001)挂运行产线 → 采样流入(基线≈环境温度)
 *   ②数控节点(温度SP 40021)REST 下发 170℃ → PLC 写入 + 同址回读一致
 *   ③闭环收敛:数采 PV 跟随爬升并稳态落在 SP 容差内(真实 Modbus 双向走线)
 *   ④数控周期读 ACT 收敛 = SET;写历史/运维留痕可查
 * 运行: node scripts/_dbg-plc-e2e.mjs(CLEANUP=1 清理测试节点)
 */
import { spawn } from 'node:child_process'

const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const CLEANUP = process.env.CLEANUP === '1'
const PORT = Number(process.env.PLC_PORT ?? 15040)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++ }

// ===== 启动 PLC 模拟器(子进程;结束即杀) =====
const sim = spawn(process.execPath, ['scripts/dev-plc-simulator.mjs', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let simLog = ''
sim.stdout.on('data', d => { simLog += String(d) })
sim.stderr.on('data', d => { simLog += String(d) })
await new Promise((resolve) => {
  const t = setTimeout(resolve, 8000)
  sim.stdout.on('data', (d) => { if (String(d).includes('就绪')) { clearTimeout(t); resolve() } })
})
check('PLC 模拟器就绪(15040)', simLog.includes('就绪'), simLog.split('\n')[0])

process.on('exit', () => { try { sim.kill() } catch {} })

// ===== 登录 + 运行产线 =====
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const j = async (u, m = 'GET', b, attempt = 0) => {
  try {
    return await fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined, signal: AbortSignal.timeout(30_000) }).then(r => r.json())
  }
  catch (err) {
    if (attempt >= 2) throw err
    await sleep(1500)
    return j(u, m, b, attempt + 1)
  }
}

const dcwData = (await j('/api/workshop/dcw')).data
const running = dcwData.lineStates?.find(s => s.active)
if (!running) {
  const cand = dcwData.lines.map(l => ({ line: l, recipe: dcwData.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
  await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
  check('运行产线(自动开跑)', true, cand.line.name)
}
else check('运行产线在跑', true, `${running.recipeName} @ line ${running.lineId}`)
const lineId = running?.lineId ?? (await j('/api/workshop/dcw')).data.lineStates.find(s => s.active)?.lineId

// ===== 幂等清理 + 建节点 =====
const extraNodes = []
for (const n of (await j('/api/workshop/daq')).data.nodes.filter(n => n.name?.startsWith('PLC闭环·'))) await j(`/api/workshop/daq/${n.id}`, 'DELETE')
for (const n of (await j('/api/workshop/dcw')).data.nodes.filter(n => n.name?.startsWith('PLC闭环·'))) await j(`/api/workshop/dcw/${n.id}`, 'DELETE')

const mb = { host: '127.0.0.1', port: PORT, unitId: 1 }
const daqNode = (await j('/api/workshop/daq', 'POST', {
  templateRef: 'daq-temp-tc', name: 'PLC闭环·温度PV', driver: 'modbus-tcp', lineId,
  driverConfig: { ...mb, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
})).data.node
const dcwNode = (await j('/api/workshop/dcw', 'POST', {
  templateRef: 'dcw-temp-sp', name: 'PLC闭环·温度SP', driver: 'modbus-tcp', lineId, min: 0, max: 300, readIntervalMs: 1000,
  driverConfig: { ...mb, register: 40021, dataType: 'float32', byteOrder: 'big' },
})).data.node
check('①数采 PV 节点 + 数控 SP 节点建立', !!daqNode?.id && !!dcwNode?.id, `${daqNode?.id} / ${dcwNode?.id}`)

const daqValue = async () => ((await j('/api/workshop/daq')).data.nodes.find(n => n.id === daqNode.id))?.value ?? null
const dcwView = async () => (await j('/api/workshop/dcw')).data.nodes.find(n => n.id === dcwNode.id)
const write = (id, value) => j(`/api/workshop/dcw/${id}/write`, 'POST', { value }).then((r) => {
  if (!r.data?.outcome) console.log('  [debug] write envelope:', JSON.stringify(r).slice(0, 200))
  return r.data?.outcome ?? { ok: false, message: r.message ?? 'unknown' }
})
const read = id => j(`/api/workshop/dcw/${id}/read`, 'POST', {}).then(r => r.data?.read ?? { ok: false, value: null, message: r.message ?? 'unknown' })

try {
  // ===== ① 基线:SP=0 → 工艺处于冷却态(PV 远低于目标,且采样在流入) =====
  let baseline = null
  let prev = null
  let flowing = false
  for (let i = 0; i < 25; i++) {
    await sleep(2000)
    baseline = await daqValue().catch(() => null)
    if (baseline != null && prev != null && baseline !== prev) flowing = true
    prev = baseline
    if (baseline != null && flowing) break
  }
  check('②基线:冷却态 PV<35℃ 且采样持续流入', baseline != null && baseline < 35 && flowing, `PV=${baseline}`)

  // ===== ② 数控下发 170(真实 Modbus 写 + 同址回读) =====
  const wResp = await j(`/api/workshop/dcw/${dcwNode.id}/write`, 'POST', { value: 170 })
  if (!wResp.data?.outcome) console.log('  [debug] write envelope:', JSON.stringify(wResp).slice(0, 220))
  const w = wResp.data.outcome
  check('③数控下发 170℃(写+回读一致)', w.ok === true, w.message.slice(0, 70))

  // ===== ③ 闭环收敛:PV 爬升并稳态(斜率 5℃/s + τ 8s → 90s 内收敛) =====
  const t0 = Date.now()
  let crossed = false
  let settled = null
  while (Date.now() - t0 < 150_000) {
    await sleep(3000)
    const v = await daqValue()
    if (v != null && v > 150 && !crossed) crossed = true
    if (crossed && Math.abs(v - 170) <= 4) { settled = v; break }
  }
  check('④闭环收敛:PV 越过 150℃(跟随 SP)', crossed)
  check('④PV 稳态落在 170±4℃(真实工艺闭环)', settled != null, `settled=${settled} 耗时=${Math.round((Date.now() - t0) / 1000)}s`)

  // ===== ④ 数控周期读 ACT 收敛;写历史留痕 =====
  const v = await dcwView()
  check('⑤数控周期读 ACT ≈ SET(170±2)', v.readValue != null && Math.abs(v.readValue - 170) <= 2 && v.lastReadAt != null, `ACT=${v.readValue} SET=${v.value}`)
  const writes = (await j(`/api/workshop/dcw/${dcwNode.id}/param-ledger`)).data?.ledger
  check('⑤下发留痕可查(param-ledger/写历史)', !!writes)

  // ===== ⑥ 标定换算节点(scale=10):物理量 = 10 × PLC 值 =====
  const cal = (await j('/api/workshop/dcw', 'POST', {
    templateRef: 'dcw-temp-sp', name: 'PLC闭环·标定×10', driver: 'modbus-tcp', readIntervalMs: 0,
    min: 0, max: 3000, transform: { kind: 'linear', scale: 10, offset: 0 },
    driverConfig: { host: '127.0.0.1', port: PORT, unitId: 1, register: 40023, dataType: 'float32', byteOrder: 'big' },
  })).data.node
  extraNodes.push(cal.id)
  const cw = await write(cal.id, 160)
  check('⑥标定节点:物理 160 → PLC 16 写入+回读一致', cw.ok === true, cw.message.slice(0, 80))
  const cr = await read(cal.id)
  check('⑥标定节点:读回 PLC 16 → 解码 160 工程量', cr.ok && Math.abs(cr.value - 160) < 0.01, `value=${cr.value} raw=${cr.raw}`)

  // ===== ⑦ 错误反馈:连接失败分类文案 =====
  const dead = (await j('/api/workshop/dcw', 'POST', {
    templateRef: 'dcw-temp-sp', name: 'PLC闭环·故障注入', driver: 'modbus-tcp', readIntervalMs: 0, min: 0, max: 300,
    driverConfig: { host: '127.0.0.1', port: 15199, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' },
  })).data.node
  extraNodes.push(dead.id)
  const t = await j(`/api/workshop/dcw/${dead.id}/test`, 'POST').then(r => r.data.test)
  check('⑦连接失败:测试连接给出可操作诊断', t.ok === false && /(无法建立连接|连接失败|端口)/.test(t.message), t.message.slice(0, 90))
  const dw = await write(dead.id, 170)
  check('⑦下发失败:连接类错误文案 + 处理提示', dw.ok === false && /(无法建立连接|超时|通信|连接)/.test(dw.message), dw.message.slice(0, 90))
  const dr = await read(dead.id)
  check('⑦读取失败:连接类错误文案', dr.ok === false && /(无法建立连接|超时|读取失败)/.test(dr.message), dr.message.slice(0, 90))

  // DAQ 侧采样失败:lastError 分类文案落到节点视图(API 可查)
  const deadDaq = (await j('/api/workshop/daq', 'POST', {
    templateRef: 'daq-temp-tc', name: 'PLC闭环·故障DAQ', driver: 'modbus-tcp', lineId,
    driverConfig: { host: '127.0.0.1', port: 15199, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
  })).data.node
  await sleep(4000)
  const deadView = (await j('/api/workshop/daq')).data.nodes.find(n => n.id === deadDaq.id)
  check('⑦DAQ 采样失败:offline + 分类错误透出', deadView.state === 'offline' && !!deadView.lastError && /(无法建立连接|超时|连接)/.test(deadView.lastError), (deadView.lastError ?? '').slice(0, 80))

  // ===== ⑧ 越量程:400 + 量程详情(安全联锁语义) =====
  const range = await j(`/api/workshop/dcw/${dcwNode.id}/write`, 'POST', { value: 999 })
  check('⑧越量程下发:400 + 量程详情', range.code === 'VALIDATION_ERROR' && /量程/.test(range.message), range.message.slice(0, 90))
}
finally {
  if (CLEANUP) {
    for (const id of extraNodes) await j(`/api/workshop/dcw/${id}`, 'DELETE').catch(() => {})
    await j(`/api/workshop/daq/${daqNode.id}`, 'DELETE').catch(() => {})
    await j(`/api/workshop/dcw/${dcwNode.id}`, 'DELETE').catch(() => {})
    const deadDaqId = (await j('/api/workshop/daq')).data.nodes.find(n => n.name === 'PLC闭环·故障DAQ')?.id
    if (deadDaqId) await j(`/api/workshop/daq/${deadDaqId}`, 'DELETE').catch(() => {})
    console.log('(cleanup:测试节点已删)')
  }
  else console.log(`(节点保留:${daqNode.id} / ${dcwNode.id} / +${extraNodes.length};CLEANUP=1 可清理)`)
  sim.kill()
}

console.log(failed === 0 ? '\nPLC-E2E ALL PASS' : `\nPLC-E2E FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
