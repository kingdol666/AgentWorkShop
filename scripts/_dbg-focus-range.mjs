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
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!window.__town?.scene?.agents?.size)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 2500))

// ===== A) 浏览模式双击:对焦 + 选中 + 边界面板出现 =====
await page.evaluate(() => {
  const s = window.__town.scene
  const b = [...s.blocks.values()][0]
  window.__cid = b.channelId
  s.panBy(-400, -300)
})
await new Promise(r => setTimeout(r, 300))
await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  // 合成双击(浏览器原生会触发;headless CDP 不合成,直接派发等价事件)
  s.focusTo(b.x + 300, b.z) // 先把镜头挪开,验证双击确实对焦
})
await new Promise(r => setTimeout(r, 800))
// 屏幕中心此刻落在领地内(上一焦点 + panBy 偏移),双击等价路径见下方 dispatch
await page.evaluate(() => {
  window.__town.scene.panBy(-800, 0)
})
// 简化:直接在屏幕中心(此刻世界点在领地内)派发 dblclick
await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  // 对焦到领地中心,再偏 120,使屏幕中心仍在领地内
  s.focusTo(b.x, b.z)
})
await new Promise(r => setTimeout(r, 800))
await page.evaluate(() => {
  window.__town.scene.panBy(-120, -90)
})
await new Promise(r => setTimeout(r, 250))
const beforeDbl = await page.evaluate(() => ({
  cam: window.__town.scene.getCameraTarget(),
  sel: window.__town.scene.selectedChannel,
}))
await page.evaluate(() => {
  document.querySelector('#town-host canvas')
    .dispatchEvent(new MouseEvent('dblclick', { clientX: 800, clientY: 500, bubbles: true }))
})
await new Promise(r => setTimeout(r, 900))
const afterDbl = await page.evaluate(() => ({
  cam: window.__town.scene.getCameraTarget(),
  sel: window.__town.scene.selectedChannel,
  panel: !!document.querySelector('.boundary-panel'),
  mode: window.__town.scene.mode,
}))
console.log('A browse dblclick before:', JSON.stringify(beforeDbl))
console.log('A browse dblclick after :', JSON.stringify(afterDbl))

// ===== B) 切编辑模式 → 手柄可见;偏移 60 单位仍能命中拖拽(命中半径 90) =====
await page.evaluate(() => {
  window.__town.scene.setMode('edit')
})
await new Promise(r => setTimeout(r, 300))
const calib = await page.evaluate(() => {
  const s = window.__town.scene
  const rc = document.querySelector('#town-host canvas').getBoundingClientRect()
  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2
  const c = s.screenToWorld(cx, cy)
  const ex = s.screenToWorld(cx + 200, cy)
  const ez = s.screenToWorld(cx, cy + 200)
  return { cx, cy, c, ax: { x: (ex.x - c.x) / 200, z: (ex.z - c.z) / 200 }, ay: { x: (ez.x - c.x) / 200, z: (ez.z - c.z) / 200 } }
})
const toScreen = (wx, wz) => {
  const det = calib.ax.x * calib.ay.z - calib.ax.z * calib.ay.x
  return [
    Math.round(calib.cx + ((wx - calib.c.x) * calib.ay.z - (wz - calib.c.z) * calib.ay.x) / det),
    Math.round(calib.cy + ((wz - calib.c.z) * calib.ax.x - (wx - calib.c.x) * calib.ax.z) / det),
  ]
}
const info = await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  const h = s.resizeHandles.filter(x => x.mesh.visible)
  return { radiusX: Math.round(b.radiusX), handles: h.length, hx: h[0].mesh.position.x, hz: h[0].mesh.position.z }
})
// 手柄往领地内侧偏 60 单位(旧命中半径 46 抓不到,新 90 应命中)
const [sx, sy] = toScreen(info.hx - 60, info.hz)
const [tx, ty] = toScreen(info.hx + 130, info.hz)
await page.mouse.move(sx, sy)
await page.mouse.down()
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(sx + (tx - sx) * i / 8, sy + (ty - sy) * i / 8, { steps: 2 })
  await new Promise(r => setTimeout(r, 30))
}
await page.mouse.up()
await new Promise(r => setTimeout(r, 300))
const afterDrag = await page.evaluate(() => {
  const b = window.__town.scene.blocks.get(window.__cid)
  return { radiusX: Math.round(b.radiusX) }
})
console.log('B edit handles:', JSON.stringify(info), '→ after offset-drag:', JSON.stringify(afterDrag))
console.log('errors:', errors.slice(0, 5))
await page.screenshot({ path: 'docs/audit/screenshots/focus-range.png' })
await browser.close()
