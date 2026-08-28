/** 一次性:数据语义标定钩子审计 —— Modbus 真实链路 decoder(数采)/encode(智控)+ 动态改标定 */
const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = process.env.DAQ_BASE ?? 'http://127.0.0.1:3000'
const DAQ = ROOT + '/api/workshop/daq'
const DCW = ROOT + '/api/workshop/dcw'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const post = (u, b) => fetch(u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json())
const get = (u) => fetch(u, { headers: H }).then(r => r.json())
const del = (u) => fetch(u, { method: 'DELETE', headers: H }).then(r => r.json())

// 产线开跑(配方驱动采集门控)
const prod = (await post(DCW + '/products', { name: '标定审计产品' })).data.product
const rc = (await post(DCW + '/recipes', { productId: prod.id, name: '标定审计配方', params: [{ templateRef: 'dcw-temp-sp', value: 180 }] })).data.recipe
await post(DCW + '/line/start', { recipeId: rc.id })

// ===== 1. DAQ decoder:读 40003(温度 float32,PLC 值 165~175),标定 scale 0.1 → 物理 ≈ 16.5~17.5 =====
const dq = (await post(DAQ, {
  templateRef: 'daq-pressure-tx', // 模板域 0.6~1.2 仅作展示;标定后物理值独立
  name: '标定-温度decoder',
  driver: 'modbus-tcp',
  driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40003, dataType: 'float32', byteOrder: 'big' },
  transform: { kind: 'linear', scale: 0.1, offset: 0 },
  intervalMs: 500,
})).data.node
if (!dq) { console.error('FAIL: create daq node'); process.exit(1) }
await sleep(2600)
let n = (await get(DAQ)).data.nodes.find(x => x.id === dq.id)
console.log(`decoder: node.value=${n.value} ${n.unit} (PLC 165~175 × 0.1 → 期望 16.5~17.5), state=${n.state}`)
if (n.value != null && n.value >= 15 && n.value <= 20) console.log('PASS daq decoder: 物理值 = PLC值 × 0.1')
else fail(`daq decoder wrong: ${n.value}`)

// 动态改标定(scale 1 → 物理值回归 PLC 域 165~175)
await fetch(`${DAQ}/${dq.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ transform: { kind: 'linear', scale: 1, offset: 0 } }) })
await sleep(1800)
n = (await get(DAQ)).data.nodes.find(x => x.id === dq.id)
console.log(`decoder live change: node.value=${n.value} (scale 1 → 期望 165~175)`)
if (n.value != null && n.value >= 160 && n.value <= 180) console.log('PASS transform change takes effect immediately')
else fail(`transform change not applied: ${n.value}`)

// ===== 2. DCW encode:写 40021(float32),节点 transform scale 0.1 → 设定 180 → PLC 写 1800;回读 decode → 180 =====
const dw = (await post(DCW, {
  templateRef: 'dcw-temp-sp',
  name: '标定-温度encode',
  driver: 'modbus-tcp',
  driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' },
  transform: { kind: 'linear', scale: 0.1, offset: 0 },
})).data.node
if (!dw) { console.error('FAIL: create dcw node'); process.exit(1) }
const w = await post(`${DCW}/${dw.id}/write`, { value: 180 })
const o = w.data?.outcome
console.log(`encode: ok=${o?.ok}, raw(PLC)=${o?.raw}, readback(物理)=${o?.readback}`)
console.log(`  ${o?.message ?? ''}`)
if (o?.ok === true && o.raw === 1800 && Math.abs(o.readback - 180) < 0.01) {
  console.log('PASS dcw encode: 物理 180 → PLC 1800(÷0.1),回读 1800 → decode 180 一致')
}
else fail(`dcw encode wrong: ${JSON.stringify(o)}`)
const dwNode = (await get(DCW)).data.nodes.find(x => x.id === dw.id)
if (dwNode?.value === 180) console.log('PASS node value keeps physical unit (180 ℃)')
else fail(`node value not physical: ${dwNode?.value}`)

// ===== 3. 无标定对照:同寄存器不带 transform 写 185 → PLC 直写 185 =====
const dw2 = (await post(DCW, {
  templateRef: 'dcw-temp-sp',
  name: '对照-无标定',
  driver: 'modbus-tcp',
  driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40023, dataType: 'float32', byteOrder: 'big' },
})).data.node
const w2 = await post(`${DCW}/${dw2.id}/write`, { value: 185 })
const o2 = w2.data?.outcome
console.log(`passthrough: ok=${o2?.ok}, raw=${o2?.raw}(期望 185,无二次换算)`)
if (o2?.ok && o2.raw === 185) console.log('PASS passthrough: kind=none 不做二次换算(防重复 scaling)')
else fail(`passthrough wrong: ${JSON.stringify(o2)}`)

// ===== 4. 非法标定拒绝(scale=0) =====
const badT = await fetch(`${DCW}/${dw.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ transform: { kind: 'linear', scale: 0, offset: 0 } }) }).then(r => r.json())
if (badT.code === 'VALIDATION_ERROR') console.log('PASS invalid transform(scale=0) rejected:', (badT.message ?? '').slice(0, 44))
else fail(`invalid transform accepted: ${badT.code}`)

// cleanup
for (const id of [dq.id, dw.id, dw2.id]) await fetch(`${DCW}/${id}`.replace('/api/workshop/dcw/', '/api/workshop/daq/') === id ? id : id, {}).catch(() => {})
await fetch(`${DAQ}/${dq.id}`, { method: 'DELETE', headers: H }).catch(() => {})
await fetch(`${DCW}/${dw.id}`, { method: 'DELETE', headers: H }).catch(() => {})
await fetch(`${DCW}/${dw2.id}`, { method: 'DELETE', headers: H }).catch(() => {})
await post(DCW + '/line/stop', {})
await del(DCW + `/recipes/${rc.id}`)
await del(DCW + `/products/${prod.id}`)
console.log('cleanup done')
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
process.exit(process.exitCode ?? 0)
