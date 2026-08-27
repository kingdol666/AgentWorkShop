/**
 * RPG 导航图审计:准星钉死图心 + 世界内容随镜头移动。
 *  - 画布中心像素恒为白色准星(镜头移动前后不变);
 *  - focusTo 远点 → 画布内容指纹变化(世界在图下滑动);
 *  - 拖拽画布 → 注视点位移;滚轮 → navZoom 变化(meta 文本 ×N)。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.agents?.size ?? 0) > 0)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 4000))

// 中心准星恒在
const centerDot = () => page.evaluate(() => {
  const cv = document.querySelector('.nav-cv')
  const x = cv.getContext('2d')
  const c = x.getImageData(cv.width / 2, cv.height / 2, 1, 1).data
  return { r: c[0], g: c[1], b: c[2], a: c[3] }
})
const d0 = await centerDot()
console.log('center pixel:', JSON.stringify(d0), d0.a > 200 ? '(OK 准星在图心)' : '(FAIL)')

// 内容指纹:镜头移动 → 指纹必须变化(世界滑动);准星不变
const finger = () => page.evaluate(() => {
  const cv = document.querySelector('.nav-cv')
  const x = cv.getContext('2d')
  const d = x.getImageData(0, 0, cv.width, cv.height).data
  let h = 0
  for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0
  return h
})
await page.evaluate(() => window.__town.scene.focusTo(2600, 1900))
await new Promise(r => setTimeout(r, 1600))
const f0 = await finger()
await page.evaluate(() => window.__town.scene.focusTo(600, 500))
await new Promise(r => setTimeout(r, 1600))
const f1 = await finger()
console.log('focus far: content fingerprint', f0, '→', f1, f0 !== f1 ? '(OK 内容随镜头移动)' : '(FAIL 未变)')
const d2 = await centerDot()
console.log('center after moves:', JSON.stringify(d2), d2.a > 200 ? '(OK 准星仍钉图心)' : '(FAIL)')

// 拖拽画布 → 注视点位移(move/up 派发到画布:Vue 处理器绑在 canvas;真实指针经 capture 重定向也到 canvas)
const t0 = (await page.evaluate(() => window.__town.scene.getCameraPose())).target
await page.evaluate(() => {
  const cv = document.querySelector('.nav-cv')
  cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 1400, clientY: 800, bubbles: true }))
})
for (let i = 0; i < 5; i++) {
  await page.evaluate(k => document.querySelector('.nav-cv').dispatchEvent(new PointerEvent('pointermove', { clientX: 1400 + (k + 1) * 12, clientY: 800, bubbles: true })), i)
}
await page.evaluate(() => document.querySelector('.nav-cv').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
const t1 = (await page.evaluate(() => window.__town.scene.getCameraPose())).target
console.log('nav drag: target delta', (t1.x - t0.x).toFixed(0), Math.hypot(t1.x - t0.x, t1.z - t0.z) > 5 ? '(OK 拖拽平移)' : '(FAIL)')

// 滚轮 → 地图缩放
await page.evaluate(() => {
  const cv = document.querySelector('.nav-cv')
  cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
})
await new Promise(r => setTimeout(r, 400))
const meta = await page.evaluate(() => document.querySelector('.mm-meta')?.textContent ?? '')
console.log('nav wheel:', meta.trim(), meta.includes('×0.9') || meta.includes('×0.8') ? '(OK 地图缩放)' : '(CHECK)')

// 截图
await page.evaluate(() => window.__town.scene.focusTo(1700, 1200))
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: 'docs/audit/screenshots/town-nav-rpg.png', clip: { x: 1250, y: 640, width: 350, height: 360 } })
console.log('pageerrors:', errors.length ? errors : 'none')
await browser.close()
