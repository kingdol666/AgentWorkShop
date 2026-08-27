import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!window.__town?.scene?.agents?.size)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 2000))
await page.evaluate(() => {
  const s = window.__town.scene
  const b = [...s.blocks.values()][0]
  window.__blk = { x: b.x, z: b.z }
  s.focusTo(b.x, b.z)
})
await new Promise(r => setTimeout(r, 800))
await page.evaluate(() => {
  window.__town.scene.panBy(-120, -90)
})
await new Promise(r => setTimeout(r, 200))
// 1) 合成 dblclick 直达 canvas
const fired = await page.evaluate(() => {
  const cv = document.querySelector('#town-host canvas')
  let got = false
  cv.addEventListener('dblclick', () => {
    got = true
  }, { once: true })
  cv.dispatchEvent(new MouseEvent('dblclick', { clientX: 800, clientY: 500, bubbles: true }))
  return got
})
await new Promise(r => setTimeout(r, 900))
const after = await page.evaluate(() => ({
  cam: window.__town.scene.getCameraTarget(),
  blk: window.__blk,
}))
console.log('synthetic dblclick dispatched:', fired)
console.log('cam:', after.cam.x, after.cam.z, 'expect:', after.blk.x, after.blk.z)
console.log('errors:', errors.slice(0, 4))
await browser.close()
