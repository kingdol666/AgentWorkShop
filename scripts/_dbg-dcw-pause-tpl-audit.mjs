/**
 * 一次性审计:控制暂停门控 + 自定义控制模板(产线管理界面新功能全链路)。
 *
 * A. 自定义模板:POST /dcw/templates 创建 → GET /dcw 载荷可见(向导下拉数据源)
 *    → 从自定义模板建节点继承域(单位/量程/小数位)。
 * B. 节点级控制暂停:PATCH enabled → 写拒绝(409「当前节点暂停」)→ 配方下发部分失败
 *    隔离 → 恢复后写 ACK;WS dcw.node.changed 状态同步帧断言。
 * C. 网关全局暂停(暂停全部控制):stop → 写/配方/开跑全拒绝(「控制网关已暂停」)
 *    → start 恢复。收尾恢复 running=true 并清理全部夹具。
 */
const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = process.env.DAQ_BASE ?? 'http://127.0.0.1:3000'
const DCW = ROOT + '/api/workshop/dcw'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jpatch = (u, b) => fetch(ROOT + u, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
const SFX = Math.random().toString(36).slice(2, 7)

// ===== 0. 健康检查 =====
const health = await jget('/api/workshop/dcw')
if (health.code !== 0) { console.error('FAIL: dev server / dcw api 不可达:', health.message); process.exit(1) }
console.log('PASS dcw api reachable; nodes:', health.data.nodes.length)

// ===== 1. 自定义控制模板:创建 → 目录可见 =====
const tplName = `暂停审计-扭矩设定-${SFX}`
const tplRes = await jpost('/api/workshop/dcw/templates', {
  name: tplName, ch: '主轴扭矩', code: `SPindle · T-${SFX}`, unit: 'N·m',
  min: 10, max: 50, decimals: 1, icon: 'encoder', semantics: '审计夹具:主轴扭矩设定,调整需小步幅。',
})
const tpl = tplRes.data?.template
if (tpl && tpl.key.startsWith('cw-') && tpl.builtin === false) console.log('PASS custom template created:', tpl.key)
else { console.error('FAIL create template:', JSON.stringify(tplRes).slice(0, 160)); process.exit(1) }
const dir = await jget('/api/workshop/dcw')
const tplInDir = dir.data.templates.find(t => t.key === tpl.key)
if (tplInDir) console.log('PASS custom template in directory (向导下拉数据源)')
else fail('custom template missing from directory payload')

// ===== 2. 从自定义模板建节点(未挂线,避开产线联锁) =====
const nodeRes = await jpost('/api/workshop/dcw', { templateRef: `dcw-${tpl.key}`, name: `暂停审计-扭矩节点-${SFX}` })
const node = nodeRes.data?.node
if (node && node.min === 10 && node.max === 50 && node.unit === 'N·m' && node.decimals === 1 && node.enabled === true) {
  console.log('PASS node created from custom template (domain inherited, enabled default)')
} else { fail(`node domain wrong: ${JSON.stringify(nodeRes).slice(0, 200)}`); process.exit(1) }

// ===== 3. 启用态写 → ACK =====
const w1 = await jpost(`/api/workshop/dcw/${node.id}/write`, { value: 30 })
if (w1.data?.outcome?.ok === true) console.log('PASS write ACK while enabled (value 30 N·m)')
else fail(`baseline write failed: ${JSON.stringify(w1).slice(0, 160)}`)

// ===== 4. 暂停节点:PATCH enabled=false → 状态同步 offline =====
await jpatch(`/api/workshop/dcw/${node.id}`, { enabled: false })
let view = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === node.id)
if (view?.enabled === false && view?.state === 'offline') console.log('PASS paused: enabled=false, state=offline (REST 权威)')
else fail(`pause state wrong: ${JSON.stringify(view && { enabled: view.enabled, state: view.state })}`)

// ===== 5. 暂停态写 → 409「当前节点暂停」 =====
const w2 = await jpost(`/api/workshop/dcw/${node.id}/write`, { value: 31 })
if (w2.code === 'CONFLICT' && (w2.message ?? '').includes('当前节点暂停')) {
  console.log('PASS paused write rejected 409 「当前节点暂停」')
} else fail(`paused write not gated: ${JSON.stringify(w2).slice(0, 160)}`)

// ===== 6. 配方下发路径:暂停节点参数记失败不阻塞其余(部分失败隔离) =====
const prod = (await jpost('/api/workshop/dcw/products', { name: `暂停审计产品-${SFX}` })).data?.product
const rc = (await jpost('/api/workshop/dcw/recipes', { productId: prod.id, name: `暂停审计配方-${SFX}`, params: [{ nodeId: node.id, value: 32 }] })).data?.recipe
const apply1 = await jpost(`/api/workshop/dcw/recipes/${rc.id}/apply`)
const r0 = apply1.data?.run?.results?.[0]
if (r0 && r0.ok === false && (r0.message ?? '').includes('当前节点暂停') && r0.nodeId === node.id) {
  console.log('PASS recipe apply: paused node param failed with 「当前节点暂停」(isolated)')
} else fail(`recipe gating wrong: ${JSON.stringify(apply1).slice(0, 200)}`)

// ===== 7. 恢复控制 → 状态回待机,写恢复 ACK =====
await jpatch(`/api/workshop/dcw/${node.id}`, { enabled: true })
view = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === node.id)
const w3 = await jpost(`/api/workshop/dcw/${node.id}/write`, { value: 33 })
if (view?.enabled === true && view?.state !== 'offline' && w3.data?.outcome?.ok === true) {
  console.log('PASS resumed: state back (idle/ok), write ACK again')
} else fail(`resume wrong: state=${view?.state}, write=${JSON.stringify(w3).slice(0, 120)}`)

// ===== 8. WS 状态同步:dcw.node.changed 帧直推 enabled 变更 =====
const chans = (await jget('/api/workshop/channels')).data ?? []
const chanId = chans[0]?.id
if (chanId) {
  const ws = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?channelId=${chanId}&token=${TOKEN}`)
  const frames = []
  ws.onmessage = (ev) => { try { frames.push(JSON.parse(String(ev.data))) } catch { /* 忽略 */ } }
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('ws connect failed'))
    setTimeout(() => rej(new Error('ws open timeout')), 8000)
  })
  await sleep(600) // 等快照对齐
  await jpatch(`/api/workshop/dcw/${node.id}`, { enabled: false })
  let gotPause = false
  for (let i = 0; i < 20 && !gotPause; i++) {
    await sleep(250)
    gotPause = frames.some(f => f.type === 'dcw.node.changed' && f.payload?.node?.id === node.id && f.payload?.node?.enabled === false)
  }
  await jpatch(`/api/workshop/dcw/${node.id}`, { enabled: true })
  let gotResume = false
  for (let i = 0; i < 20 && !gotResume; i++) {
    await sleep(250)
    gotResume = frames.some(f => f.type === 'dcw.node.changed' && f.payload?.node?.id === node.id && f.payload?.node?.enabled === true)
  }
  ws.close()
  if (gotPause && gotResume) console.log('PASS WS sync: dcw.node.changed frames pushed enabled=false/true')
  else fail(`WS sync frames missing: pause=${gotPause} resume=${gotResume}`)
} else {
  console.log('SKIP WS sync assertion(无可见 channel);REST 权威态已在第 4/7 步断言')
}

// ===== 9. 网关全局暂停(暂停全部控制) =====
let ctl = (await jpost('/api/workshop/dcw/controller', { action: 'stop' })).data?.controller
if (ctl?.running === false && ctl?.nodesOnline === 0) console.log('PASS gateway stopped: running=false, nodesOnline=0')
else fail(`gateway stop wrong: ${JSON.stringify(ctl)}`)
const w4 = await jpost(`/api/workshop/dcw/${node.id}/write`, { value: 34 })
if (w4.code === 'CONFLICT' && (w4.message ?? '').includes('控制网关已暂停')) {
  console.log('PASS gateway-paused write rejected (暂停全部控制现在真正拦截下发)')
} else fail(`gateway write gate wrong: ${JSON.stringify(w4).slice(0, 160)}`)
const apply2 = await jpost(`/api/workshop/dcw/recipes/${rc.id}/apply`)
const r1 = apply2.data?.run?.results?.[0]
if (r1 && r1.ok === false && (r1.message ?? '').includes('控制网关已暂停')) {
  console.log('PASS gateway-paused recipe apply rejected')
} else fail(`gateway recipe gate wrong: ${JSON.stringify(apply2).slice(0, 200)}`)

// ===== 10. 网关暂停时开跑门控 =====
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fx = await makeLineFixture(ROOT, H, `暂停审计线-${SFX}`)
const prod2 = (await jpost('/api/workshop/dcw/products', { name: `暂停审计产品B-${SFX}`, lineId: fx.line.id })).data?.product
const rc2 = (await jpost('/api/workshop/dcw/recipes', { productId: prod2.id, name: `暂停审计配方B-${SFX}`, params: [{ nodeId: node.id, value: 35 }] })).data?.recipe
const g1 = await fx.start(rc2.id)
if (g1.code === 'CONFLICT' && (g1.message ?? '').includes('控制网关已暂停')) {
  console.log('PASS line start gated while gateway paused')
} else fail(`line start gate wrong: ${JSON.stringify(g1).slice(0, 160)}`)
await fx.cleanup()

// ===== 11. 恢复全部控制 → 写恢复 ACK =====
ctl = (await jpost('/api/workshop/dcw/controller', { action: 'start' })).data?.controller
view = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === node.id)
const w5 = await jpost(`/api/workshop/dcw/${node.id}/write`, { value: 36 })
if (ctl?.running === true && view?.state !== 'offline' && w5.data?.outcome?.ok === true) {
  console.log('PASS gateway resumed: enabled node back online, write ACK')
} else fail(`gateway resume wrong: ${JSON.stringify({ ctl, state: view?.state, w: w5.message ?? w5.data?.outcome?.message }).slice(0, 200)}`)

// ===== 清理:夹具全删 + 网关确保 running =====
await jdel(`/api/workshop/dcw/recipes/${rc.id}`)
await jdel(`/api/workshop/dcw/products/${prod.id}`)
await jdel(`/api/workshop/dcw/${node.id}`)
await jdel(`/api/workshop/dcw/templates/${tpl.key}`)
const after = await jget('/api/workshop/dcw')
const cleaned = !after.data.templates.some(t => t.key === tpl.key) && !after.data.nodes.some(n => n.id === node.id)
if (cleaned) console.log('PASS cleanup: fixtures removed')
else fail('cleanup incomplete')
const finalCtl = after.data.controller
if (finalCtl.running === true) console.log('PASS final: gateway running=true (环境还原)')
else { await jpost('/api/workshop/dcw/controller', { action: 'start' }); fail('gateway was left stopped — restored') }

console.log(process.exitCode ? '\n=== AUDIT FAILED ===' : '\n=== ALL PASS ===')
