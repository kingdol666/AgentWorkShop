/**
 * 新协议全链 REST 验证:MQTT/HTTP/RTU 三种新驱动节点
 * 创建(元数据持久化)→ 测试连接 → 实际采样数据到达(产线开跑,门控放行)。
 * 前置:dev-protocol-simulators(1883/1889)+ _rtu-mini-slave(15030)+ DAQ 网关运行
 * 运行:AW_PAGE_TOKEN=<token> node scripts/_newdriver-rest-probe.mjs
 */
const BASE = 'http://127.0.0.1:3000'
const H = { 'authorization': `Bearer ${process.env.AW_PAGE_TOKEN ?? ''}`, 'content-type': 'application/json' }
let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  }
  else {
    fail++
    console.log(`FAIL ${label}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = Math.random().toString(36).slice(2, 6)
const jpost = async (u, b) => {
  const r = await fetch(`${BASE}${u}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.code !== 0) console.log(`  [debug] POST ${u} → ${r.status} ${JSON.stringify(j).slice(0, 160)}`)
  return j
}

// ---- 0) 网关运行(DCW 写控制 + DAQ 采集共用开关) ----
{
  const r = await fetch(`${BASE}/api/workshop/dcw`, { headers: H }).then(x => x.json())
  if (!r?.data?.controller?.running)
    await fetch(`${BASE}/api/workshop/dcw/controller?action=resume`, { method: 'POST', headers: H }).then(x => x.json())
  const d = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(x => x.json())
  if (!d?.data?.controller?.running)
    await fetch(`${BASE}/api/workshop/daq/controller`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'resume' }) })
}

// ---- 1) 夹具:产线 + 数控节点 + 产品 + 配方(开跑激活采集门控) ----
const line = (await jpost('/api/workshop/dcw/lines', { name: `新协议线-${rand}` })).data.line
const dcwNode = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: `新协议设定-${rand}`, lineId: line.id })).data.node
const product = (await jpost('/api/workshop/dcw/products', { lineId: line.id, name: `新协议产品-${rand}` })).data.product
const recipe = (await jpost('/api/workshop/dcw/recipes', { productId: product.id, name: `新协议配方-${rand}`, params: [{ nodeId: dcwNode.id, value: 175 }] })).data.recipe
const start = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id })
ok(start.code === 0, `产线开跑(采集门控放行)`)

// ---- 2) MQTT 节点:创建 → 持久化 → test → 采样 ----
const mqttNode = (await jpost('/api/workshop/daq', {
  templateRef: 'daq-temp-tc',
  name: `MQTT采集-${rand}`,
  driver: 'mqtt',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: 'aw/sim/temp', jsonPath: 'data.temp' },
  lineId: line.id,
  intervalMs: 1000,
})).data.node
ok(!!mqttNode?.id && mqttNode.driver === 'mqtt', `MQTT 节点创建(driver=${mqttNode?.driver})`)
const daqList = (await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())).data
ok(daqList.nodes.some(n => n.id === mqttNode.id && n.driverConfig?.topic === 'aw/sim/temp'), 'MQTT driverConfig 持久化在册(daqs.json)')
const mt = await fetch(`${BASE}/api/workshop/daq/${mqttNode.id}/test`, { method: 'POST', headers: H }).then(r => r.json())
ok(mt.data?.test?.ok === true, `MQTT test 连接(${mt.data?.test?.message?.slice(0, 60)})`)

// ---- 3) HTTP 节点:同链 ----
const httpNode = (await jpost('/api/workshop/daq', {
  templateRef: 'daq-temp-tc',
  name: `HTTP采集-${rand}`,
  driver: 'http',
  driverConfig: { url: 'http://127.0.0.1:1889/api/value', jsonPath: 'data.value' },
  lineId: line.id,
  intervalMs: 1000,
})).data.node
ok(!!httpNode?.id && httpNode.driver === 'http', 'HTTP 节点创建')
const ht = await fetch(`${BASE}/api/workshop/daq/${httpNode.id}/test`, { method: 'POST', headers: H }).then(r => r.json())
ok(ht.data?.test?.ok === true && Number.isFinite(ht.data?.test?.sampleValue), `HTTP test 连接+取值(${ht.data?.test?.sampleValue})`)

// ---- 4) RTU 节点:创建 + test(需 RTU 从站模拟器 15030) ----
const rtuNode = (await jpost('/api/workshop/daq', {
  templateRef: 'daq-temp-tc',
  name: `RTU采集-${rand}`,
  driver: 'modbus-rtu',
  driverConfig: { host: '127.0.0.1', port: 15030, unitId: 1, register: 40001, dataType: 'uint16' },
  lineId: line.id,
  intervalMs: 1000,
})).data.node
ok(!!rtuNode?.id && rtuNode.driver === 'modbus-rtu', 'RTU 节点创建')
const rt = await fetch(`${BASE}/api/workshop/daq/${rtuNode.id}/test`, { method: 'POST', headers: H }).then(r => r.json())
ok(rt.data?.test?.ok === true, `RTU test 连接(${rt.data?.test?.message?.slice(0, 60)})`)

// ---- 5) 实际采样到达(等 2-3 个采样周期) ----
await sleep(3500)
const nodesAfter = (await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())).data
const mqttLive = nodesAfter.nodes.find(n => n.id === mqttNode.id)
const httpLive = nodesAfter.nodes.find(n => n.id === httpNode.id)
const rtuLive = nodesAfter.nodes.find(n => n.id === rtuNode.id)
ok(mqttLive?.value != null && Number.isFinite(mqttLive.value), `MQTT 节点真实采样值到达(value=${mqttLive?.value})`)
ok(httpLive?.value != null && Number.isFinite(httpLive.value), `HTTP 节点真实采样值到达(value=${httpLive?.value})`)
ok(rtuLive?.value != null && Number.isFinite(rtuLive.value), `RTU 节点真实采样值到达(value=${rtuLive?.value})`)

console.log(`\n=== 结果:${pass} PASS / ${fail} FAIL ===`)
process.exit(fail > 0 ? 1 : 0)
