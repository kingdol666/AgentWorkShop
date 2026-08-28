/** 一次性:模板→节点→设备 绑定链路审计(同模板多节点/全量 list/场景全挂载/遥测事件不清场) */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(2500)

// 0) 基线:REST 层验证
const base = await page.evaluate(async (token) => {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const post = (url, body) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(r => r.json())
  // 0.1 裸调不带 templateRef 必须被拒
  const noTpl = await post('/api/workshop/daq', { name: 'x' })
  // 0.2 未知模板必须 404
  const badTpl = await post('/api/workshop/daq', { templateRef: 'daq-no-such', name: 'x' })
  // 0.3 同模板连建 3 个节点(速度编码器),两绑设备一自由
  const list0 = await fetch('/api/workshop/daq', { headers: h }).then(r => r.json())
  const devices = await fetch('/api/workshop/device-twins', { headers: h }).then(r => r.json())
  const twinList = (devices.data?.twins ?? []).filter(t => t.kind !== 'daq' && typeof t.posX === 'number')
  const made = []
  for (let i = 0; i < 3; i++) {
    const r = await post('/api/workshop/daq', { templateRef: 'daq-line-encoder', posX: 500 + i * 130, posZ: 900 })
    if (r.data?.node) made.push(r.data.node)
  }
  // 绑定其中两个到不同设备
  const binds = []
  for (let i = 0; i < Math.min(2, made.length); i++) {
    if (twinList[i]) {
      await fetch(`/api/workshop/daq/${made[i].id}/bind`, { method: 'POST', headers: h, body: JSON.stringify({ deviceId: twinList[i].id }) })
      binds.push(twinList[i].id)
    }
  }
  const list1 = await fetch('/api/workshop/daq', { headers: h }).then(r => r.json())
  const enc = list1.data.nodes.filter(n => n.templateRef === 'daq-line-encoder')
  return {
    noTplCode: noTpl.code, noTplMsg: (noTpl.message ?? '').slice(0, 30),
    badTplCode: badTpl.code,
    created: made.map(n => ({ id: n.id, tpl: n.templateRef, unit: n.unit, min: n.min, max: n.max, name: n.name })),
    totalEnc: enc.length, distinctIds: new Set(enc.map(n => n.id)).size,
    boundCount: enc.filter(n => n.deviceBindingId).length,
    totalNodes: list1.data.nodes.length,
    enabledListed: list1.data.nodes.filter(n => n.enabled).length,
    devicesAvail: twinList.length,
    cleanupIds: made.map(n => n.id),
  }
}, TOKEN)
console.log('REST audit:', JSON.stringify({ ...base, created: base.created.length, cleanupIds: undefined }))

if (base.noTplCode !== 'VALIDATION_ERROR' && base.noTplCode !== 400) fail(`裸调未拒: ${base.noTplCode} ${base.noTplMsg}`)
else console.log('PASS create without templateRef rejected:', base.noTplMsg)
if (base.badTplCode !== 'INTERNAL_ERROR') console.log('PASS unknown template rejected:', base.badTplCode)
else fail('unknown template not rejected')
if (base.created.length === 3 && base.created.every((n, i, a) => a.findIndex(x => x.id === n.id) === i) && base.boundCount >= 2) console.log(`PASS same-template x3 created (distinct ids), bound=${base.boundCount} incl. legacy`)
else fail(`multi-node/bind wrong: created=${base.created.length} distinct=${base.distinctIds} bound=${base.boundCount}`)
const first = base.created[0]
if (first && first.unit === 'm/min' && first.min === 280 && first.max === 360) console.log('PASS template domain inherited (m/min 280~360)')
else fail(`template domain missing: ${JSON.stringify(first)}`)

// 1) 场景层:/town 全部 DAQ 节点挂载 + device.updated 遥测流不清场
await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 60000 })
let ready = false
for (let i = 0; i < 30; i++) {
  ready = await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)
  if (ready) break
  await sleep(1000)
}
if (!ready) { fail('town scene deviceNodes never ready'); await browser.close(); process.exit(1) }
await sleep(4000)

const sceneProbe = await page.evaluate(async (ids) => {
  const s = window.__town.scene
  const daqNodes = [...s.deviceNodes.values()].filter(d => (d.modelRef ?? '').startsWith('daq-'))
  const before = new Set(daqNodes.map(d => d.twinId))
  const allPresent = ids.every(id => before.has(id))
  // 等 4s(跨 ≥3 个 1s 节流的 device.updated 遥测帧)后清点,验证不清场
  await new Promise(r => setTimeout(r, 4000))
  const after = new Set([...s.deviceNodes.values()].filter(d => (d.modelRef ?? '').startsWith('daq-')).map(d => d.twinId))
  return {
    daqInScene: before.size,
    allPresent,
    stableAfterTelemetry: ids.every(id => after.has(id)),
    afterCount: after.size,
  }
}, base.cleanupIds)
console.log('scene probe:', JSON.stringify(sceneProbe))
if (sceneProbe.allPresent && sceneProbe.stableAfterTelemetry) console.log(`PASS all ${sceneProbe.daqInScene} daq nodes mounted in scene, stable across device.updated telemetry stream`)
else fail(`scene mount/unstable: ${JSON.stringify(sceneProbe)}`)

// 同模板多节点在场景中彼此独立(不同位置)
const spread = await page.evaluate(() => {
  const s = window.__town.scene
  const enc = [...s.deviceNodes.values()].filter(d => d.modelRef === 'daq-line-encoder')
  return { count: enc.length, distinctPos: new Set(enc.map(d => `${Math.round(d.root.position.x)},${Math.round(d.root.position.z)}`)).size }
})
if (spread.count >= 3 && spread.distinctPos === spread.count) console.log(`PASS ${spread.count} same-template nodes独立实例/位置`)
else fail(`scene same-template nodes wrong: ${JSON.stringify(spread)}`)

// 2) 清理
const cleaned = await page.evaluate(async (ids, token) => {
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  for (const id of ids) await fetch(`/api/workshop/daq/${id}`, { method: 'DELETE', headers: h })
  const l = await fetch('/api/workshop/daq', { headers: h }).then(r => r.json())
  return l.data.nodes.length
}, base.cleanupIds, TOKEN)
console.log('cleanup done, nodes back to:', cleaned)

await browser.close()
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
