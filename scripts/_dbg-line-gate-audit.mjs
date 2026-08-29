/** 一次性:产线门控审计 —— 无配方不采集;配方设定值可查;开跑即采样+推流;停线即停;双向设备绑定(mock) */
const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = process.env.DAQ_BASE ?? 'http://127.0.0.1:3000'
const DCW = ROOT + '/api/workshop/dcw'
const DAQ = ROOT + '/api/workshop/daq'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const post = (u, b) => fetch(u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json())
const del = (u) => fetch(u, { method: 'DELETE', headers: H })
const get = (u) => fetch(u, { headers: H }).then(r => r.json())

// 0) 产线夹具(逐产线门控)
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fx = await makeLineFixture(ROOT, H, '门控审计产线')

// 1) mock 自定义模板 + 节点 + 双向绑定
const daqTpl = (await post(DAQ + '/templates', { name: '门控-厚度', unit: 'um', min: 30, max: 60, decimals: 1, icon: 'gateway', ch: '膜厚' })).data.template
const dcwTpl = (await post(DCW + '/templates', { name: '门控-厚度设定', unit: 'um', min: 30, max: 60, decimals: 1, icon: 'gateway', ch: '膜厚设定' })).data.template
const devList = (await get(ROOT + '/api/workshop/device-twins')).data?.twins ?? []
const dev = devList.find(t => t.kind !== 'daq' && typeof t.posX === 'number')
const dq = (await post(DAQ, { templateRef: `daq-${daqTpl.key}`, name: '门控-厚度通道', intervalMs: 500, posX: dev.posX + 40, posZ: dev.posZ + 40, lineId: fx.line.id })).data.node
const dw = (await post(DCW, { templateRef: `dcw-${dcwTpl.key}`, name: '门控-厚度设定', posX: dev.posX - 40, posZ: dev.posZ - 40 })).data.node
await post(`${DAQ}/${dq.id}/bind`, { deviceId: dev.id })
await post(`${DCW}/${dw.id}/bind`, { deviceId: dev.id })
const daqN = (await get(DAQ)).data.nodes.find(n => n.id === dq.id)
const dcwN = (await get(DCW)).data.nodes.find(n => n.id === dw.id)
if (daqN?.deviceBindingId === dev.id && dcwN?.deviceBindingId === dev.id) console.log('PASS daq+dcw both bound to device(数字孪生绑定)')
else fail('bind failed')

// 2) 门控-未开跑:produced 不增(不采样不推流)
const p0 = (await get(DAQ)).data.controller.produced
await sleep(2600)
const p1 = (await get(DAQ)).data.controller.produced
console.log(`gated(idle): produced ${p0} -> ${p1}`)
if (p1 === p0) console.log('PASS no acquisition without active recipe')
else fail(`sampling while line idle: +${p1 - p0}`)

// 3) 产品/配方管理 + 设定值查看
const prod = (await post(DCW + '/products', { name: '门控审计产品', description: 'recipe mgmt', lineId: fx.line.id })).data.product
const rc = (await post(DCW + '/recipes', {
  productId: prod.id,
  name: '门控审计配方',
  params: [{ templateRef: `dcw-${dcwTpl.key}`, nodeId: dw.id, value: 45 }],
})).data.recipe
const rcList = (await get(DCW)).data.recipes.find(r => r.id === rc.id)
console.log('recipe params(设定值):', JSON.stringify(rcList?.params))
if (rcList?.productId === prod.id && rcList?.params?.[0]?.value === 45 && rcList?.params?.[0]?.nodeId === dw.id) {
  console.log('PASS product/recipe mgmt + setpoint viewable (45 um → 指定节点)')
}
else fail('recipe mgmt/setpoint wrong')

// 4) 开跑:配方下发(节点 value=45)+ 采集启动 + 实时帧
const st = await fx.start(rc.id)
if (!st.data?.line?.active) { fail(`line start: ${JSON.stringify(st).slice(0, 140)}`); process.exit(1) }
const dwApplied = (await get(DCW)).data.nodes.find(n => n.id === dw.id)
console.log('recipe applied to node:', dwApplied?.value, dwApplied?.state)
if (dwApplied?.value === 45 && dwApplied?.state === 'ok') console.log('PASS recipe setpoint applied via line start')
else fail(`apply wrong: ${dwApplied?.value}/${dwApplied?.state}`)

// WS 实时消费帧(订阅真实频道)
const channels = await get(ROOT + '/api/workshop/channels')
const channelId = channels.data?.[0]?.id
const ws = new WebSocket(ROOT.replace('http', 'ws') + '/api/workshop/ws')
let frames = 0
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data)
  if (f.type === 'daq.reading' && f.payload.nodeId === dq.id) frames++
}
ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId, token: TOKEN }))
await sleep(1000)
const p2 = (await get(DAQ)).data.controller.produced
frames = 0
await sleep(3800)
const p3 = (await get(DAQ)).data.controller.produced
ws.close()
console.log(`running: produced +${p3 - p2} in ~3.8s, ws frames on target=${frames}, node value=${(await get(DAQ)).data.nodes.find(n => n.id === dq.id)?.value}`)
if (p3 - p2 >= 3) console.log('PASS acquisition runs while recipe active')
else fail(`no sampling after start: +${p3 - p2}`)
if (frames >= 3) console.log('PASS real-time WS consumption flowing')
else fail(`ws frames low: ${frames}`)

// 5) 打标数据归产品(隔离)
const q = await get(`${DCW}/line/query?productId=${prod.id}&recipeId=${rc.id}&paramKey=${daqTpl.key}&from=${Date.now() - 60_000}&to=${Date.now()}`)
const pts = q.data?.channels?.find(c => c.nodeId === dq.id)?.points ?? []
if (pts.length >= 3) console.log(`PASS tagged data under product+recipe (${pts.length} points)`)
else fail(`tagged points: ${pts.length}`)

// 6) 停线:采集即停 + 节点 offline
const sp = await fx.stop()
await sleep(2600)
const p4 = (await get(DAQ)).data.controller.produced
const nodesAfter = (await get(DAQ)).data.nodes.find(n => n.id === dq.id)
console.log(`after stop: produced +${p4 - p3}, node state=${nodesAfter?.state}`)
if (p4 === p3) console.log('PASS acquisition halted after line stop')
else fail(`still sampling after stop: +${p4 - p3}`)

// cleanup
await del(`${DAQ}/${dq.id}`)
await del(`${DCW}/${dw.id}`)
await del(`${DCW}/recipes/${rc.id}`)
await del(`${DCW}/products/${prod.id}`)
await del(`${DAQ}/templates/${daqTpl.key}`)
await del(`${DCW}/templates/${dcwTpl.key}`)
await fx.cleanup()
console.log('cleanup done')
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
process.exit(process.exitCode ?? 0)
