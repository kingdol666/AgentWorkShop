/** 一次性:产线运营全链路审计(mock 自定义模板/节点绑定/实时读数/设参/开跑门控/逐样本打标/产品隔离查询/停止) */
const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = (process.env.DAQ_BASE ?? 'http://127.0.0.1:3000')
const DCW = ROOT + '/api/workshop/dcw'
const DAQ = ROOT + '/api/workshop/daq'
const DEV = ROOT + '/api/workshop/device-twins'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const jpost = (u, b) => fetch(u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json())
const jdel = (u) => fetch(u, { method: 'DELETE', headers: H }).then(r => r.json())

// ===== 1. mock 自定义模板(数采 + 智控) =====
const daqTpl = (await jpost(DAQ + '/templates', { name: '线审计-厚度', unit: 'um', min: 30, max: 60, decimals: 1, icon: 'gateway', ch: '膜厚' })).data.template
const dcwTpl = (await jpost(DCW + '/templates', { name: '线审计-厚度设定', unit: 'um', min: 30, max: 60, decimals: 1, icon: 'gateway', ch: '膜厚设定' })).data.template
console.log('templates:', daqTpl?.key, dcwTpl?.key)
if (!daqTpl || !dcwTpl) { console.error('FAIL: create templates'); process.exit(1) }

// ===== 2. 节点 + 设备绑定(mock 驱动) =====
const devList = (await fetch(DEV, { headers: H }).then(r => r.json())).data?.twins ?? []
const dev = devList.find(t => t.kind !== 'daq' && typeof t.posX === 'number')
if (!dev) { console.error('FAIL: no device twin for binding'); process.exit(1) }
const dq = (await jpost(DAQ, { templateRef: `daq-${daqTpl.key}`, name: '线审计-厚度通道', intervalMs: 500, posX: dev.posX + 40, posZ: dev.posZ + 40 })).data.node
const dw = (await jpost(DCW, { templateRef: `dcw-${dcwTpl.key}`, name: '线审计-厚度设定', posX: dev.posX - 40, posZ: dev.posZ - 40 })).data.node
await jpost(`${DAQ}/${dq.id}/bind`, { deviceId: dev.id })
await jpost(`${DCW}/${dw.id}/bind`, { deviceId: dev.id })
const daqNode = (await fetch(DAQ, { headers: H }).then(r => r.json())).data.nodes.find(n => n.id === dq.id)
const dcwNode = (await fetch(DCW, { headers: H }).then(r => r.json())).data.nodes.find(n => n.id === dw.id)
console.log('bound:', daqNode?.deviceBindingId === dev.id, dcwNode?.deviceBindingId === dev.id)
if (daqNode?.deviceBindingId === dev.id && dcwNode?.deviceBindingId === dev.id) console.log('PASS daq+dcw nodes bound to same device')
else fail('bind failed')

// ===== 3. 设参(mock;写控制不受产线门控) =====
const w = await jpost(`${DCW}/${dw.id}/write`, { value: 45 })
if (w.data?.outcome?.ok) console.log('PASS set control param 45um (mock PLC ACK)')
else fail(`write failed: ${JSON.stringify(w).slice(0, 100)}`)

// ===== 4. 产品/配方 + 开跑门控 =====
const prod = (await jpost(DCW + '/products', { name: '线审计产品A', description: '隔离验证' })).data.product
const rc = (await jpost(DCW + '/recipes', { productId: prod.id, name: '线审计配方', params: [{ templateRef: `dcw-${dcwTpl.key}`, nodeId: dw.id, value: 45 }] })).data.recipe
// 4.1 无配方开跑 → 400
const g1 = await jpost(DCW + '/line/start', { recipeId: 'rc-nonexist' })
if (g1.code === 'NOT_FOUND') console.log('PASS start gating: unknown recipe rejected')
else fail(`gating unknown recipe: ${g1.code}`)
// 4.2 空参数配方 → 400
const rcEmpty = (await jpost(DCW + '/recipes', { productId: prod.id, name: '空参数配方', params: [] })).data.recipe
const g2 = await jpost(DCW + '/line/start', { recipeId: rcEmpty.id })
if (g2.code === 'VALIDATION_ERROR') console.log('PASS start gating: recipe without params rejected ——', (g2.message ?? '').slice(0, 24))
else fail(`gating empty recipe: ${g2.code}`)

// ===== 5. 开跑:参数下发 + 窗口打标 =====
const st = await jpost(DCW + '/line/start', { recipeId: rc.id })
console.log('line start:', st.data?.run?.id, '| recipe applied:', JSON.stringify(st.data?.run?.results?.[0]?.ok))
if (st.data?.line?.active && st.data?.run?.results?.[0]?.ok === true) console.log('PASS line started with recipe applied')
else fail(`line start wrong: ${JSON.stringify(st).slice(0, 160)}`)
// 重复开跑 → 409
const again = await jpost(DCW + '/line/start', { recipeId: rc.id })
if (again.code === 'CONFLICT') console.log('PASS double-start rejected (409)')
else fail(`double start: ${again.code}`)

await sleep(3500) // 收集打标样本(500ms 通道)
// 实时读数(产线开跑后;门控语义:配方驱动采集)
const live = (await fetch(DAQ, { headers: H }).then(r => r.json())).data.nodes.find(n => n.id === dq.id)
console.log('live value:', live?.value, live?.state)
if (live?.value != null && live?.state !== 'offline') console.log('PASS real-time daq reading flowing (recipe-driven)')
else fail('no live reading while line active')

// ===== 6. 逐样本打标验证:按产品+配方+参数查询,数据必须归属本产品 =====
const q = await fetch(`${DCW}/line/query?productId=${prod.id}&recipeId=${rc.id}&paramKey=${daqTpl.key}&from=${Date.now() - 60_000}&to=${Date.now()}&bucketMs=1000`, { headers: H }).then(r => r.json())
const ch = q.data?.channels?.find(c => c.nodeId === dq.id)
console.log(`tagged query: channels=${q.data?.channels?.length}, points on target=${ch?.points?.length}`)
if ((ch?.points?.length ?? 0) > 0) console.log('PASS tagged samples queryable by product+recipe+param')
else fail(`tagged query empty: ${JSON.stringify(q).slice(0, 160)}`)

// 6.2 换一个不存在的产品查询 → 空(隔离)
const q2 = await fetch(`${DCW}/line/query?productId=pd-nonexist&from=${Date.now() - 60_000}&to=${Date.now()}`, { headers: H }).then(r => r.json())
if ((q2.data?.channels ?? []).length === 0) console.log('PASS isolation: other product sees no data')
else fail(`isolation broken: ${q2.data.channels.length} channels leaked`)

// ===== 7. 停止:窗口封闭,新样本不再打标 =====
const sp = await jpost(DCW + '/line/stop', {})
if (sp.data?.run?.endedAt) console.log('PASS line stopped, run sealed:', sp.data.run.endedAt)
else fail('stop failed')
await sleep(1600)
const q3 = await fetch(`${DCW}/line/query?productId=${prod.id}&from=${Date.now() - 120_000}&to=${Date.now()}&bucketMs=1000`, { headers: H }).then(r => r.json())
const pts3 = q3.data?.channels?.find(c => c.nodeId === dq.id)?.points ?? []
const lastAt = pts3.length ? Math.max(...pts3.map(p => p.at)) : 0
const stopAt = Date.parse(sp.data.run.endedAt)
if (lastAt <= stopAt + 1500) console.log(`PASS post-stop samples untagged (last tagged ${lastAt - stopAt}ms before/at stop)`)
else fail(`samples tagged after stop: +${lastAt - stopAt}ms`)

// ===== 清理 =====
await jdel(`${DAQ}/${dq.id}`)
await jdel(`${DCW}/${dw.id}`)
await jdel(`${DCW}/recipes/${rc.id}`)
await jdel(`${DCW}/recipes/${rcEmpty.id}`)
await jdel(`${DCW}/products/${prod.id}`)
await jdel(`${DAQ}/templates/${daqTpl.key}`)
await jdel(`${DCW}/templates/${dcwTpl.key}`)
console.log('cleanup done')
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
process.exit(process.exitCode ?? 0)
