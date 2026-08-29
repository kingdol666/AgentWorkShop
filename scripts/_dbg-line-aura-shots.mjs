/** 一次性:产线光晕 + 页面验收截图 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const OUT = 'docs/audit/screenshots'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1.5 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

// 1. 孪生场景:数采/智控节点产线光晕(1号蓝/2号黄)
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
await sleep(5000)
await page.evaluate(() => {
  const s = window.__town.scene
  const nodes = [...s.deviceNodes.values()].filter(d => (d.modelRef ?? '').startsWith('dcw-'))
  if (nodes.length) s.focusTo?.(nodes[0].root.position.x, nodes[0].root.position.z)
})
await sleep(1500)
await page.screenshot({ path: `${OUT}/line-aura-scene.png` })
console.log('shot: line-aura-scene.png')

// 2. /dcw 产线总览
await page.goto(`${ROOT}/dcw`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await sleep(3500)
await page.screenshot({ path: `${OUT}/line-ops-overview.png` })
console.log('shot: line-ops-overview.png')

// 3. /dcw/{id} 产线详情(第一条线)
const lineId = await page.evaluate(async () => {
  const token = document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? ''
  const r = await fetch('/api/workshop/dcw/lines', { headers: { authorization: `Bearer ${decodeURIComponent(token)}` } }).then(x => x.json())
  return r.data?.lines?.[0]?.id ?? ''
})
if (lineId) {
  await page.goto(`${ROOT}/dcw/${lineId}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await sleep(3500)
  await page.screenshot({ path: `${OUT}/line-ops-detail.png` })
  console.log('shot: line-ops-detail.png')
}

await browser.close()
console.log('DONE')
