/** 端到端 Phase 1:1号产线 绑定 数采/数控节点 → 开跑 → 数采/数控链路活体断言(留线运行)
 *  ① 数控节点(温度/压力设定器示例)重绑 控制台·CON + 落位
 *  ② 3 个数采节点 分配到 1号产线 + 绑定挤出机/MD/TD + 落位到设备旁
 *  ③ A-标准工艺 开跑 → 配方参数 ACK(设定值=目标) + 写历史带批次 + 数采 produced 增长
 */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

const d = (await J('/api/workshop/dcw')).data
const line = d.lines.find(l => l.name === '1号产线')
const recipe = d.recipes.find(r => r.lineId === line.id && r.params.length > 0)
const console_ = (await J('/api/workshop/device-twins')).data.twins.find(t => t.name === '控制台 · CON')
const devByName = async n => (await J('/api/workshop/device-twins')).data.twins.find(t => t.name === n)
const extruder = await devByName('挤出机 L1')
const mdo = await devByName('MD 纵拉机 L1')
const tdo = await devByName('TD 拉幅机 L1')
console.log('line:', line.name, line.id, '| recipe:', recipe.name, '| console:', console_.id)

// ── ① 数控节点:重绑控制台 + 落位到控制台旁 ──
const dcwTargets = recipe.params.map((p, i) => ({ p, node: d.nodes.find(n => n.id === p.nodeId), off: i * 26 }))
for (const t of dcwTargets) {
  await J(`/api/workshop/dcw/${t.node.id}/bind`, 'POST', { deviceId: console_.id })
  await J(`/api/workshop/dcw/${t.node.id}`, 'PATCH', {
    posX: Math.round(console_.posX + 95 + t.off),
    posZ: Math.round(console_.posZ - 90),
  })
  console.log('① dcw bound+placed:', t.node.name, '→ 控制台·CON', `(${t.node.id.slice(0, 10)})`)
}

// ── ② 数采节点:分配产线 + 绑设备 + 落位 ──
const daq = (await J('/api/workshop/daq')).data
const pick = (namePrefix, driver = 'mock') => daq.nodes.find(n =>
  !n.lineId && n.name.startsWith(namePrefix) && n.enabled && (n.driver === driver || driver === 'any'))
const daqPlan = [
  { node: daq.nodes.find(n => n.id === 'dn-lg-dev-mtbagkfu-8qd40') ?? pick('压力变送器 01'), dev: extruder },
  { node: pick('温度传感器 01'), dev: mdo },
  { node: pick('张力传感器 01') ?? pick('温度传感器 02'), dev: tdo },
].filter(x => x.node && x.dev)
for (const { node, dev } of daqPlan) {
  await J(`/api/workshop/daq/${node.id}`, 'PATCH', { lineId: line.id })
  await J(`/api/workshop/daq/${node.id}/bind`, 'POST', { deviceId: dev.id })
  await J(`/api/workshop/daq/${node.id}`, 'PATCH', { posX: Math.round(dev.posX + 45), posZ: Math.round(dev.posZ + 35) })
  console.log('② daq assigned+bound+placed:', node.name, '→', dev.name, `(${node.id.slice(0, 12)})`)
}

// ── ③ 开跑 A-标准工艺 ──
const produced0 = (await J('/api/workshop/daq')).data.meta.produced
const st = await J(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
if (!st.data?.line?.active) {
  console.error('FAIL line start:', JSON.stringify(st).slice(0, 250))
  process.exit(1)
}
console.log('③ line STARTED | runId:', st.data.line.runId?.slice(0, 10), '| recipe:', recipe.name)

await sleep(2500)
// 数控断言:设定值 = 配方目标 + 写历史带批次
const d2 = (await J('/api/workshop/dcw')).data
let dcwOk = 0
for (const p of recipe.params) {
  const n = d2.nodes.find(x => x.id === p.nodeId)
  const hit = n && Math.abs((n.value ?? NaN) - p.value) < 0.01 && n.state === 'ok'
  if (hit) dcwOk++
  else console.error('FAIL dcw param:', n?.name, 'value=', n?.value, 'expect', p.value, 'state=', n?.state)
}
console.log(dcwOk === recipe.params.length ? `PASS 数控下发 ACK: ${dcwOk}/${recipe.params.length} 设定值=配方目标` : 'FAIL 数控下发')
const hist = d2.history.filter(h => h.recipeRunId === st.data.line.runId)
console.log(hist.length >= recipe.params.length && hist.every(h => h.ok)
  ? `PASS 写历史: ${hist.length} 条带批次 runId 全 ACK`
  : `FAIL 写历史: ${hist.length}`)

// 数采断言:produced 增长 + 目标节点实时值变化
await sleep(4000)
const mid = (await J('/api/workshop/daq')).data
console.log(mid.meta.produced > produced0 ? `PASS 数采启动: produced ${produced0} → ${mid.meta.produced}` : `FAIL produced 未增长 (${produced0})`)
await sleep(4000)
const mid2 = (await J('/api/workshop/daq')).data
for (const { node } of daqPlan) {
  const n1 = mid.nodes.find(n => n.id === node.id)
  const n2 = mid2.nodes.find(n => n.id === node.id)
  const ok = n2?.value != null && n2.value !== n1?.value
  console.log(ok ? `PASS 实时值变化: ${node.name} ${n1.value} → ${n2.value} ${n2.unit} (${n2.state})` : `FAIL ${node.name} 值未更新 (${n1?.value} → ${n2?.value}, ${n2?.state})`)
}
console.log('PHASE1 DONE(留线运行)')
