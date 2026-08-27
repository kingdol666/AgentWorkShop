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
await new Promise(r => setTimeout(r, 2500))
const s0 = await page.evaluate(() => {
  const s = window.__town.scene
  return { yaw: +s.viewCur.yaw.toFixed(3), pitch: +s.viewCur.pitch.toFixed(3), r: Math.round(s.viewCur.radius) }
})
// 环绕:orbafitBy yaw +1.2 / pitch +0.3
await page.evaluate(() => {
  const s = window.__town.scene
  for (let i = 0; i < 12; i++) s.orbitBy(8, -4)
})
await new Promise(r => setTimeout(r, 600))
const s1 = await page.evaluate(() => {
  const s = window.__town.scene
  const c = s.camera.position
  return { yaw: +s.viewCur.yaw.toFixed(3), pitch: +s.viewCur.pitch.toFixed(3), camY: Math.round(c.y), camX: Math.round(c.x) }
})
console.log('orbit:', JSON.stringify({ before: s0, after: s1 }))
// 预设:side
await page.evaluate(() => {
  window.__town.scene.setViewPreset('side')
})
await new Promise(r => setTimeout(r, 1600))
const s2 = await page.evaluate(() => {
  const s = window.__town.scene
  const c = s.camera.position
  return { yaw: +s.viewCur.yaw.toFixed(2), camX: Math.round(c.x), camY: Math.round(c.y), camZ: Math.round(c.z) }
})
console.log('preset side:', JSON.stringify(s2))
await page.screenshot({ path: 'docs/audit/screenshots/orbit-side.png' })
// 中键平移:panByScreen 沿右向移动
const s3 = await page.evaluate(() => {
  const s = window.__town.scene
  const t0 = { ...s.getCameraTarget() }
  s.panByScreen(80, 0)
  const t1 = s.getCameraTarget()
  return { dx: Math.round(t1.x - t0.x), dz: Math.round(t1.z - t0.z) }
})
console.log('pan right(80px):', JSON.stringify(s3))
console.log('errors:', errors.slice(0, 4))
await browser.close()
