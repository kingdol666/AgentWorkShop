/** 一次性:双节拍(采集入库 intervalMs / WS 下发 publishIntervalMs)独立控制验证 */
const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const BASE = (process.env.DAQ_BASE ?? 'http://127.0.0.1:3000') + '/api/workshop/daq'
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(r => r.json())
const patch = (id, body) => fetch(`${BASE}/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) }).then(r => r.json())
const get = () => fetch(BASE, { headers: H }).then(r => r.json())

// 0) 产线门控前置:数采由配方驱动,先建产品+配方并开跑(无匹配节点的参数记失败不阻塞)
const DCW = (process.env.DAQ_BASE ?? 'http://127.0.0.1:3000') + '/api/workshop/dcw'
const dpost = (u, b) => fetch(DCW + u, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json())
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fx = await makeLineFixture(process.env.DAQ_BASE ?? 'http://127.0.0.1:3000', H, 'daq-cadence 线')
const gateProd = (await dpost('/products', { name: '节拍审计产品', lineId: fx.line.id })).data.product
const gateRc = (await dpost('/recipes', { productId: gateProd.id, name: '节拍审计配方', params: [{ templateRef: 'dcw-temp-sp', value: 180 }] })).data.recipe
const gateStart = await fx.start(gateRc.id)
if (!gateStart.data?.line?.active) { console.error('FAIL: line start for gating:', JSON.stringify(gateStart).slice(0, 140)); process.exit(1) }
console.log('line gating: started (recipe-driven acquisition)')

// 0b) 建两个同模板节点:A=采样 500ms/下发 2500ms;B=采样 500ms/下发 0(每帧)
const a = (await post('', { templateRef: 'daq-line-encoder', name: '双节拍A', intervalMs: 500, publishIntervalMs: 2500, posX: 100, posZ: 100, lineId: fx.line.id })).data.node
const b = (await post('', { templateRef: 'daq-line-encoder', name: '双节拍B', intervalMs: 500, publishIntervalMs: 0, posX: 140, posZ: 100, lineId: fx.line.id })).data.node
if (!a || !b) { console.error('FAIL: create nodes'); process.exit(1) }
console.log('created:', a.id, a.publishIntervalMs, '|', b.id, b.publishIntervalMs)

// 1) 页内原生 WS 订阅,统计 7s 内两节点的 daq.reading 帧数与入库数对比
const counts = await (async () => {
  const browser = await import('puppeteer-core')
  return null
})()

// 裸 WS 客户端(Node 22+ 原生 WebSocket):daq.reading 走 scene-events 直达已订阅 peer,
// 订阅任一可见真实频道即可完成 peer 注册
const base = process.env.DAQ_BASE ?? 'http://127.0.0.1:3000'
const channels = await fetch(base + '/api/workshop/channels', { headers: H }).then(r => r.json())
const chanList = channels.data ?? []
const channelId = (Array.isArray(chanList) ? chanList[0] : chanList.channels?.[0] ?? chanList.items?.[0])?.id
if (!channelId) { console.error('FAIL: no channel to subscribe'); process.exit(1) }
const wsURL = base.replace('http', 'ws') + '/api/workshop/ws'
const ws = new WebSocket(wsURL)
const seen = {}
let snap = false
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data)
  if (f.type === 'daq.reading' && (f.payload.nodeId === a.id || f.payload.nodeId === b.id)) {
    seen[f.payload.nodeId] = (seen[f.payload.nodeId] ?? 0) + 1
  }
  if (f.type === 'channel.snapshot') snap = true
}
ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId, token: TOKEN }))
await sleep(1500)
if (!snap) console.error('WARN: no snapshot — sub may have failed, frames unreliable')

// 采 7s 窗口:预期 A(500ms 采/2500ms 发)≈2 帧,B(500ms 采/0)≈14 帧
const t0 = Date.now()
seen[a.id] = 0
seen[b.id] = 0
await sleep(7000)
const elapsed = Date.now() - t0
ws.close()

// 2) 入库数对比(TSDB 查询):A 与 B 的样本数应都 ≈14(每采样必入库,与下发无关)
const now = Date.now()
const qa = await fetch(`${BASE}/${a.id}/samples?from=${now - 9000}&to=${now}`, { headers: H }).then(r => r.json())
const qb = await fetch(`${BASE}/${b.id}/samples?from=${now - 9000}&to=${now}`, { headers: H }).then(r => r.json())
const sa = (qa.data?.points ?? []).length
const sb = (qb.data?.points ?? []).length

console.log(`window ${elapsed}ms | WS frames: A(publish 2500ms)=${seen[a.id]}, B(publish 0)=${seen[b.id]} | stored: A=${sa}, B=${sb}`)

// 3) 全局缺省跟随验证:PATCH A 回 null → controllerState.defaultPublishIntervalMs 生效
const pa = await patch(a.id, { publishIntervalMs: null })
if (pa.data?.node?.publishIntervalMs === null) console.log('PASS publishIntervalMs=null reset (follow global)')
else fail(`null reset wrong: ${JSON.stringify(pa.data?.node?.publishIntervalMs)}`)

// 4) 全局 config:defaultPublishIntervalMs=800 → controllerState 反映
const cfg = await post('/controller', { action: 'config', defaultPublishIntervalMs: 800 })
if (cfg.data?.controller?.defaultPublishIntervalMs === 800) console.log('PASS gateway defaultPublishIntervalMs configurable')
else fail(`gateway config wrong: ${JSON.stringify(cfg.data?.controller)}`)
await post('/controller', { action: 'config', defaultPublishIntervalMs: 0 })

// 5) 判定
const framesA = seen[a.id] ?? 0
const framesB = seen[b.id] ?? 0
if (!snap) console.log('WARN: no snapshot frame (channelId empty sub may skip; frames still counted)')
if (framesA >= 1 && framesA <= 4 && framesB >= 8) {
  console.log(`PASS dual-cadence: A(2.5s publish)=${framesA} frames vs B(every frame)=${framesB} in 7s`)
}
else {
  fail(`cadence wrong: A=${framesA} (expect 1~4), B=${framesB} (expect >=8)`)
}
if (sa >= 8 && sb >= 8) console.log(`PASS storage unaffected by publish gating (A=${sa}, B=${sb} samples stored)`)
else fail(`storage gated wrongly: A=${sa}, B=${sb}`)

// cleanup:停线(采集门控关闭)+ 删节点/配方/产品
for (const id of [a.id, b.id]) await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: H })
await fx.cleanup()
await fetch(`${DCW}/recipes/${gateRc.id}`, { method: 'DELETE', headers: H })
await fetch(`${DCW}/products/${gateProd.id}`, { method: 'DELETE', headers: H })
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
process.exit(process.exitCode ?? 0)
