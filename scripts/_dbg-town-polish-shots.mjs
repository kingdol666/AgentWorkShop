/** 一次性:UI polish 验收截图 —— 智控设定卡(populated)/DCW 检查器/总览 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const OUT = 'docs/audit/screenshots'
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fx = await makeLineFixture(ROOT, H, 'polish 产线')

// ===== 前置:开跑配方(带窗口) + 绑定智控节点到设备,让「智控设定」卡 populated =====
const dcw = await jget('/api/workshop/dcw')
let dwTemp = (dcw.data?.nodes ?? []).find(n => n.name === 'polish-温度设定')
if (!dwTemp) {
  dwTemp = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'polish-温度设定', posX: -1700, posZ: 2200 })).data.node
}
const twins = (await jget('/api/workshop/device-twins')).data.twins.filter(t => t.kind !== 'daq' && typeof t.posX === 'number')
const dev = twins.find(t => t.name.includes('控制台')) ?? twins[0]
if (!dwTemp.deviceBindingId || dwTemp.deviceBindingId !== dev.id) {
  await jpost(`/api/workshop/dcw/${dwTemp.id}/bind`, { deviceId: dev.id })
}
let prod = (dcw.data?.products ?? []).find(p => p.name === 'polish-产品')
if (!prod) prod = (await jpost('/api/workshop/dcw/products', { name: 'polish-产品', lineId: fx.line.id })).data.product
else await jpost(`/api/workshop/dcw/products/${prod.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ lineId: fx.line.id }) })
let rc = (dcw.data?.recipes ?? []).find(r => r.name === 'polish-配方')
if (!rc) {
  rc = (await jpost('/api/workshop/dcw/recipes', { productId: prod.id, name: 'polish-配方', params: [{ templateRef: 'dcw-temp-sp', nodeId: dwTemp.id, value: 182, min: 176, max: 188 }] })).data.recipe
}
await fx.start(rc.id)
console.log('line started, bound:', dwTemp.id, '->', dev.name)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1.5 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
await sleep(5000)

// 1. 总览(运行视角)
await page.screenshot({ path: `${OUT}/polish-overview.png` })

// 2. 编辑模式 + 选中设备(智控设定卡 populated:配方窗口行)
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  btns.find(b => b.textContent.trim() === '编辑')?.click()
})
await sleep(400)
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dev.id)
await sleep(900)
await page.screenshot({ path: `${OUT}/polish-device-panel.png` })

// 3. 选中智控节点(DCW 检查器)
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dwTemp.id)
await sleep(900)
await page.screenshot({ path: `${OUT}/polish-dcw-inspector.png` })

// 右栏特写(设备面板,高清裁切看卡片细节)
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dev.id)
await sleep(900)
const rail = await page.$('.rail-right')
if (rail) await rail.screenshot({ path: `${OUT}/polish-right-rail.png` })

await browser.close()

// ===== 清理(停线 + 删 fixture;节点保留供后续轮次复用) =====
await fx.cleanup()
await jdel(`/api/workshop/dcw/recipes/${rc.id}`)
await jdel(`/api/workshop/dcw/products/${prod.id}`)
await jpost(`/api/workshop/dcw/${dwTemp.id}/bind`, { deviceId: null })
console.log('SHOTS DONE')
