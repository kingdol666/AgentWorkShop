/** 一次性:Town 智控节点场景挂载 + 设定值联动验证(REST 建 dcw 节点 → 场景实例 → 设定值变化) */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
await sleep(3000)
const before = await page.evaluate(() => window.__town.scene.deviceNodes.size)
console.log('scene devices before:', before)

// REST 创建 2 个智控节点(带落点)→ townBus dcw.node.changed / 签名 watch 收敛
const made = []
for (const tpl of ['temp-sp', 'speed-sp']) {
  const r = await fetch('http://127.0.0.1:3000/api/workshop/dcw', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ templateRef: `dcw-${tpl}`, posX: 800 + made.length * 130, posZ: 1500 }),
  }).then(x => x.json())
  if (r.data?.node) made.push(r.data.node)
  await sleep(1200) // 等 WS 帧/签名 watch 收敛
}
const afterCreate = await page.evaluate(() => {
  const s = window.__town.scene
  const dcw = [...s.deviceNodes.values()].filter(d => (d.modelRef ?? '').startsWith('dcw-'))
  return { total: s.deviceNodes.size, dcw: dcw.length, ids: dcw.map(d => d.twinId) }
})
console.log('after create:', JSON.stringify(afterCreate))
// 场景可能已有持久化 dcw 节点(示例等用户数据)→ 只要求新建节点全部挂载
if (made.every(m => afterCreate.ids.includes(m.id))) {
  console.log(`PASS ${made.length} dcw nodes mounted in town scene`)
}
else fail(`dcw scene mount wrong: ${JSON.stringify(afterCreate)}`)

// 设定值下发 → dcw.written 帧 → 场景节点 value 收敛(telemetry.value)
await fetch(`http://127.0.0.1:3000/api/workshop/dcw/${made[0].id}/write`, {
  method: 'POST', headers: H, body: JSON.stringify({ value: 185 }),
})
await sleep(2000)
const setVal = await page.evaluate((id) => {
  const s = window.__town.scene
  const d = [...s.deviceNodes.values()].find(x => x.twinId === id)
  return d?.telemetry?.value ?? null
}, made[0].id)
console.log('scene telemetry.value after write:', setVal)
if (setVal === 185) console.log('PASS setpoint write reflected in scene node telemetry')
else fail(`setpoint not reflected: ${setVal}`)

// 清理
for (const n of made) await fetch(`http://127.0.0.1:3000/api/workshop/dcw/${n.id}`, { method: 'DELETE', headers: H })
await sleep(1500)
const cleaned = await page.evaluate(id => ![...window.__town.scene.deviceNodes.values()].some(d => d.twinId === id), made[0].id)
if (cleaned) console.log('PASS dcw node removal converges in scene')
else fail('dcw node not removed from scene')

await page.screenshot({ path: 'docs/audit/screenshots/town-dcw.png' })
await browser.close()
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
