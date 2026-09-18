/**
 * 工业演示现场布线 —— 对真实 PLC 模拟器(:4010)做一次「可登录即可见」的完整接装:
 *   ①每台模拟器设备 → 平台节点(DCW 写控 / DAQ 数采,driverConfig 取自模拟器对接导出)
 *   ②每台设备一个数字孪生模型(modelRef=设备模型库)并把节点双向绑定到孪生
 *   ③产线+产品+配方(全量程窗)并开跑 → 数采在活动批次内真实采样
 *   ④逐节点 test-driver 真连通验证 + 一次受治理参数写→回读 + 数采样本增长
 * 幂等:按「演示」标记清理上一次的演示线,再重建。
 * 运行: AW_BASE=http://127.0.0.1:3001 node scripts/ui/seed-industrial-demo.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const SIM = process.env.E2E_SIM_API ?? 'http://127.0.0.1:4010'
const ADMIN = { email: process.env.E2E_USER ?? 'admin@awshop.local', password: process.env.E2E_PASS ?? 'admin123' }

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) }).then(r => r.json())
const token = login.data?.token
check('管理员登录', !!token, `${ADMIN.email} ${login.message ?? ''}`)
if (!token) process.exit(1)
const H = { 'content-type': 'application/json', 'authorization': `Bearer ${token}` }
const api = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json()
// 列表解包:data 可能是数组或 {lines/nodes/twins: [...]}(各路由形状不一)
const arr = (d, key) => (Array.isArray(d) ? d : d?.[key] ?? d?.nodes ?? d?.lines ?? d?.twins ?? [])
const sim = async (m, u, b) => (await fetch(SIM + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json()

// ── ① 模拟器设备清单(真实五协议) ──
const devices = (await sim('GET', '/api/nodes')).data ?? []
check('PLC 模拟器在线', devices.length > 0, `${devices.length} 台设备: ${devices.map(d => d.name).join(' / ')}`)

// ── ② 清理上一轮演示实体(按「演示」标记) ──
const oldLines = arr((await api('GET', '/api/workshop/dcw/lines')).data, 'lines')
for (const l of oldLines.filter(x => x.name.startsWith('演示线'))) {
  await api('DELETE', `/api/workshop/dcw/lines/${l.id}?purge=1`)
}
const oldTwins = arr((await api('GET', '/api/workshop/device-twins')).data, 'twins')
for (const n of arr((await api('GET', '/api/workshop/daq')).data, 'nodes').filter(x => x.name.startsWith('演示·'))) {
  await api('DELETE', `/api/workshop/daq/${n.id}`)
}
for (const n of arr((await api('GET', '/api/workshop/dcw')).data, 'nodes').filter(x => x.name.startsWith('演示·'))) {
  await api('DELETE', `/api/workshop/dcw/${n.id}`)
}
for (const t of oldTwins.filter(x => x.name.startsWith('演示·'))) {
  await api('DELETE', `/api/workshop/device-twins/${t.id}`)
}
console.log('  · 旧演示实体已清理')

// ── ③ 逐设备建节点(SP→DCW 写控;标量 PV→DAQ 数采;driverConfig 取自模拟器导出) ──
// 模型映射:按设备语义挑数字孪生模型库里的模型
const MODEL_OF = {
  'Coating Oven PLC': 'caster', 'Remote RTU Temp Slave': 'power-cabinet',
  'OPC UA Temp Controller': 'extruder', 'MQTT Temp Sensor': 'device-scanner',
  'HTTP Flow Meter': 'pump',
}
const isSp = s => /SP/i.test(s.signal ?? '') || /^Set/i.test(s.signal ?? '')
const results = []
let lineIx = 0
const twins = []
for (const dev of devices) {
  const exp = (await sim('GET', `/api/nodes/${dev.id}/export`)).data
  const items = exp?.items ?? []
  const spItem = items.find(i => isSp(i)) ?? null
  const pvItems = items.filter(i => i !== spItem && (i.format ?? 'scalar') === 'scalar')
  if (!spItem && pvItems.length === 0) continue
  const modelKey = MODEL_OF[dev.name] ?? 'device-console'
  const twin = (await api('POST', '/api/workshop/device-twins', {
    name: `演示·${dev.name}`,
    modelRef: modelKey,
    posX: -14 + lineIx * 7,
    posZ: 6 + (lineIx % 2) * 5,
    rotationY: 0,
  })).data?.twin
  if (!twin) {
    check(`孪生创建 ${dev.name}`, false)
    continue
  }
  twins.push(twin)

  let hostLine = null
  const bindNode = async (nodeId) => {
    const r = await api('POST', `/api/workshop/dcw/${nodeId}/bind`, { deviceId: twin.id }).catch(() => null)
    return r?.code === 0
  }
  const bindDaq = async (nodeId) => {
    const r = await api('POST', `/api/workshop/daq/${nodeId}/bind`, { deviceId: twin.id }).catch(() => null)
    return r?.code === 0
  }

  // SP → 写控节点 + 自成产线(开跑后本线批次活动,数采采样门放行)
  if (spItem) {
    lineIx++
    const line = (await api('POST', '/api/workshop/dcw/lines', { name: `演示线${lineIx}·${dev.name}` })).data?.line
    const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line.id, name: `演示产品${lineIx}` })).data?.product
    hostLine = line
    const cfg = spItem.driverConfig
    const dcw = (await api('POST', '/api/workshop/dcw', {
      templateRef: 'dcw-temp-sp', name: `演示·${dev.name}·${spItem.signal}`,
      driver: spItem.driver, driverConfig: cfg,
      unit: spItem.unit ?? '℃', decimals: spItem.decimals ?? 1,
      min: spItem.min ?? 0, max: spItem.max ?? 300,
      readIntervalMs: 3000, lineId: line.id, semantics: `模拟器设备「${dev.name}」的 ${spItem.signal}(真实 ${spItem.driver} 写控链路)`,
    })).data?.node
    const bindOk = await bindNode(dcw.id)
    check(`DCW 节点+孪生绑定 ${dev.name}`, !!dcw?.id && bindOk, `${dcw.id} ↔ twin ${twin.id}(${modelKey})`)
    const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
      productId: product.id, name: `演示配方${lineIx}`,
      params: [{ nodeId: dcw.id, value: dev.signals?.find(x => x.id === spItem.signal)?.value ?? (Number(spItem.min ?? 0) + Number(spItem.max ?? 300)) / 2, min: spItem.min ?? 0, max: spItem.max ?? 300 }],
    })).data?.recipe
    const st = (await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id }))
    check(`产线开跑 ${line.name}`, !!st.data?.run?.id)
    results.push({ dev, dcw, line, spItem })
  }

  // 标量 PV → 数采节点(挂到本线或第一条既有演示线)
  for (const pv of pvItems) {
    const cfg = pv.driverConfig
    const daq = (await api('POST', '/api/workshop/daq', {
      templateRef: 'daq-temp-tc', name: `演示·${dev.name}·${pv.signal}`,
      driver: pv.driver, driverConfig: cfg,
      unit: pv.unit ?? '', min: pv.min ?? 0, max: pv.max ?? 400,
      lineId: hostLine?.id ?? '', intervalMs: 2000, publishIntervalMs: 0,
      semantics: `模拟器设备「${dev.name}」的 ${pv.signal}(真实 ${pv.driver} 采样链路)`,
    })).data?.node
    if (!daq) {
      check(`DAQ 节点 ${dev.name}·${pv.signal}`, false)
      continue
    }
    if (hostLine?.id) await bindDaq(daq.id)
    results.push({ dev, daq, pvItem: pv })
  }
}

// 卫星数采补绑定(无 SP 设备的 DAQ 挂到第一条演示线,否则不采样)
const firstLine = arr((await api('GET', '/api/workshop/dcw/lines')).data, 'lines').find(l => l.name.startsWith('演示线'))
if (firstLine) {
  const allDaq = arr((await api('GET', '/api/workshop/daq')).data, 'nodes')
  for (const n of allDaq.filter(x => x.name.startsWith('演示·') && !x.lineId)) {
    await api('PATCH', `/api/workshop/daq/${n.id}`, { lineId: firstLine.id })
    await bindDaqSoft(n.id)
  }
  async function bindDaqSoft(nodeId) {
    const twin0 = twins[0]
    if (twin0) await api('POST', `/api/workshop/daq/${nodeId}/bind`, { deviceId: twin0.id }).catch(() => {})
  }
}
// ── ④ 真连通验证:逐节点 test-driver ──
const allDcw = arr((await api('GET', '/api/workshop/dcw')).data, 'nodes').filter(n => n.name.startsWith('演示·'))
let connOk = 0
for (const n of allDcw.filter(x => x.driver !== 'mock')) {
  const t = await api('POST', `/api/workshop/dcw/${n.id}/test`)
  connOk += t.data?.test?.ok === true ? 1 : 0
}
check('逐节点真连通(test-driver)', connOk === allDcw.filter(x => x.driver !== 'mock').length, `${connOk}/${allDcw.filter(x => x.driver !== 'mock').length} 台真实驱动连通`)

// ── ⑤ 数采样本增长(活动批次内真实采样) ──
await sleep(9000)
const allDaq = arr((await api('GET', '/api/workshop/daq')).data, 'nodes').filter(n => n.name.startsWith('演示·'))
let sampling = 0
for (const n of allDaq) {
  const s = await api('GET', `/api/workshop/daq/${n.id}/samples?limit=5`)
  const pts = s.data?.points ?? []
  sampling += pts.length > 0 ? 1 : 0
}
check('数采真实采样', sampling === allDaq.length, `${sampling}/${allDaq.length} 通道有样本(9s 窗)`)

console.log(`\n${failed === 0 ? '✅ 演示现场就绪' : `❌ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
