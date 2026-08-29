/** 一次性:创建产线示例(产品/Recipe/mock PLC 节点)+ 越窗联锁验证 */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = (r) => r.json()
const post = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(j)
const get = (u) => fetch(ROOT + u, { headers: H }).then(j)

// ===== 1. 产品 ×2 =====
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fxA = await makeLineFixture(ROOT, H, '1号产线')
const fxB = await makeLineFixture(ROOT, H, '2号产线')
const pA = (await post('/api/workshop/dcw/products', { name: '0.8mm 光学膜', description: '高端光学级 PET 膜(示例产品 A)', lineId: fxA.line.id })).data.product
const pB = (await post('/api/workshop/dcw/products', { name: '12μm 离型膜', description: '薄型离型保护膜(示例产品 B)', lineId: fxB.line.id })).data.product
console.log('products:', pA.id, pA.name, '|', pB.id, pB.name)

// ===== 2. mock PLC 节点(数采 + 智控),绑定到已有设备 =====
const twins = (await get('/api/workshop/device-twins')).data.twins.filter(t => t.kind !== 'daq' && typeof t.posX === 'number')
const dev = twins[0]
console.log('bind target:', dev?.name)
const nodes = {}
const mk = [
  ['daq', 'daq-temp-tc', '温度传感器(示例)', dev?.id, fxA.line.id],
  ['daq', 'daq-pressure-tx', '熔体压力变送器(示例)', dev?.id, fxB.line.id],
  ['dcw', 'dcw-temp-sp', '温度设定器(示例)', dev?.id, fxA.line.id],
  ['dcw', 'dcw-temp-sp', '温度设定器·2号线(示例)', dev?.id, fxB.line.id],
  ['dcw', 'dcw-pressure-sp', '压力设定器(示例)', dev?.id, fxA.line.id],
]
for (const [kind, tpl, name, deviceId, lineId] of mk) {
  const base = kind === 'daq' ? '/api/workshop/daq' : '/api/workshop/dcw'
  // 每线独立节点(产线隔离:配方参数只能引用本线节点);场景光晕 1号蓝/2号黄
  const r = await post(base, { templateRef: tpl, name, posX: 600 + Math.random() * 400, posZ: 1500 + Math.random() * 300, deviceBindingId: deviceId ?? null, lineId })
  const n = r.data?.node
  if (!n) { console.error('FAIL create node', tpl, JSON.stringify(r).slice(0, 120)); process.exit(1) }
  if (name.includes('2号线')) nodes[`${tpl}-2`] = n
  else nodes[tpl] = n
  console.log('node:', kind, n.templateRef, n.id, '| domain', n.min, '~', n.max, n.unit)
}

// ===== 3. Recipe(各自工艺窗口;value 必须在自身窗口内) =====
const rA = (await post('/api/workshop/dcw/recipes', {
  productId: pA.id,
  name: 'A-标准工艺',
  description: '光学膜标准批次:温度窗口收紧到 ±5℃',
  params: [
    { templateRef: 'dcw-temp-sp', nodeId: nodes['dcw-temp-sp'].id, value: 182, min: 176, max: 188 },
    { templateRef: 'dcw-pressure-sp', nodeId: nodes['dcw-pressure-sp'].id, value: 0.92, min: 0.85, max: 1.0 },
  ],
})).data.recipe
const rB = (await post('/api/workshop/dcw/recipes', {
  productId: pB.id,
  name: 'B-低温工艺',
  description: '离型膜低温批次:与 A 产品窗口完全不同(产品隔离)',
  params: [
    { templateRef: 'dcw-temp-sp', nodeId: nodes['dcw-temp-sp-2'].id, value: 162, min: 156, max: 170 },
  ],
})).data.recipe
if (!rA || !rB) { console.error('FAIL: recipes'); process.exit(1) }
console.log('recipes:', rA.id, rA.name, JSON.stringify(rA.params), '|', rB.id, rB.name)

// ===== 4. 越窗联锁验证:开跑 A,写 195(节点全局 150~200 内、配方上限 188 外)→ 拒绝 =====
const startA = await fxA.start(rA.id)
console.log('line A:', startA.data?.line?.active, startA.data?.line?.recipeName)
const wIn = await post(`/api/workshop/dcw/${nodes['dcw-temp-sp'].id}/write`, { value: 180 })
console.log('write 180 (in window):', wIn.data?.outcome?.ok)
const wOut = await post(`/api/workshop/dcw/${nodes['dcw-temp-sp'].id}/write`, { value: 195 })
console.log('write 195 (over recipe max 188):', wOut.code, '|', (wOut.message ?? '').slice(0, 70))
let pass = true
if (wIn.data?.outcome?.ok !== true) { console.error('FAIL: in-window write failed'); pass = false }
if (wOut.code !== 'VALIDATION_ERROR') { console.error('FAIL: over-window write accepted'); pass = false }
// 切到 B 再写 195 → 仍拒(B 窗口 156~170);写 165 → 成功(在 A 下会被拒的值)
const startB = await fxA.stop()
await fxB.start(rB.id)
// B 线联锁作用于 2号线的温度节点(产线隔离:A 线节点不受 B 配方约束)
const wB1 = await post(`/api/workshop/dcw/${nodes['dcw-temp-sp-2'].id}/write`, { value: 195 })
const wB2 = await post(`/api/workshop/dcw/${nodes['dcw-temp-sp-2'].id}/write`, { value: 165 })
console.log('recipe B: write 195 →', wB1.code, '| write 165 →', wB2.data?.outcome?.ok ? 'OK' : 'FAIL')
if (wB1.code === 'VALIDATION_ERROR' && wB2.data?.outcome?.ok) console.log('PASS recipe switch changes interlock window')
else { console.error('FAIL: recipe-B interlock wrong'); pass = false }
await fxB.stop()
console.log(pass ? 'EXAMPLES + INTERLOCK ALL PASS' : 'FAILED')
