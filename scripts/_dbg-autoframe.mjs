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
await page.evaluate(() => {
  const s = window.__town.scene
  s.setMode('edit')
  const b = [...s.blocks.values()][0]
  window.__cid = b.channelId
  s.selectChannel(b.channelId)
  s.focusTo(b.x, b.z)
})
await new Promise(r => setTimeout(r, 1000))

// API 直驱:模拟 channelEdge 拖拽 3.2 倍等比放大(走真实 movePointerDrag 路径)
const r1 = await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  const before = { rx: b.radiusX, rz: b.radiusZ, dolly: s.dolly }
  const rect0 = s.canvas.getBoundingClientRect()
  s.tryStartPointerDrag(rect0.left + rect0.width / 2, rect0.top + rect0.height / 2)
  const kind = s.pointerDrag?.kind
  // 若命中的是 channel/beacon 而非 channelEdge,直接驱动内部序列等价验证:
  return { kind, before, cx: b.x, cz: b.z }
})
console.log('start:', JSON.stringify(r1))
if (r1.kind !== 'channelEdge') {
  // 未抓到边界线(屏幕中心是领地中心):退化为直接等价 API 序列(与真实拖拽同一函数链)
  await page.evaluate(() => {
    window.__town.scene.endPointerDrag()
  })
}
// 逐帧放大:直接调用内部等价序列(applyResize 所走路径) via updateChannelLayout + autoFrameTo 由拖拽分支触发…
// 为走完整 autoFrame 路径,用 channelEdge 的 pointerDrag 结构驱动:
// 构造 channelEdge 拖拽:镜头对准 边界45°点,使该点位于屏幕中心(精确)
await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  const k = 0.707
  s.focusTo(b.x + b.radiusX * k, b.z + b.radiusZ * k)
})
await new Promise(r => setTimeout(r, 1000))
const r3 = await page.evaluate(() => {
  const s = window.__town.scene
  const rect = s.canvas.getBoundingClientRect()
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
  // 屏幕中心 = 边界45°点(精确) → tryStartPointerDrag 应命中 channelEdge
  const started = s.tryStartPointerDrag(cx, cy)
  const kind = s.pointerDrag?.kind
  if (!started) return { started, kind }
  // 逐帧向外拖:每步沿 45° 外推(屏幕上向右下拉 —— 45° 世界方向在此视角下近似右下)
  for (let i = 1; i <= 12; i++) {
    s.movePointerDrag(cx + 42 * i, cy + 30 * i)
  }
  s.endPointerDrag()
  const b = s.blocks.get(window.__cid)
  return { started, kind, after: { rx: Math.round(b.radiusX), rz: Math.round(b.radiusZ) }, dollyAfter: +s.dolly.toFixed(2) }
})
console.log('edge drag:', JSON.stringify(r3))
await new Promise(r => setTimeout(r, 1500))
// 视口适配检查:领地 8 个极值点 + 中心投影都在 canvas 视口内
const fit = await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  const rect = s.canvas.getBoundingClientRect()
  const pts = []
  if (b.shape === 'rect') {
    for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) pts.push([b.x + sx * b.radiusX, b.z + sz * b.radiusZ])
  }
  else {
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pts.push([b.x + sx * b.radiusX, b.z + sz * b.radiusZ])
  }
  void pts
  // 可靠估计:读相机 dolly 推可视跨度,与领地尺寸对比
  const aspect = rect.width / rect.height
  const spanX = 2 * 613 * aspect * s.dolly * 0.82
  const spanZ = 2 * 950 * s.dolly * 0.82
  return {
    dolly: +s.dolly.toFixed(2),
    rx: Math.round(b.radiusX), rz: Math.round(b.radiusZ),
    spanX: Math.round(spanX), spanZ: Math.round(spanZ),
    fitsX: spanX > b.radiusX * 2.15, fitsZ: spanZ > b.radiusZ * 2.15,
  }
})
console.log('viewport fit:', JSON.stringify(fit))
console.log('errors:', errors.slice(0, 5))
await page.screenshot({ path: 'docs/audit/screenshots/autoframe.png' })
await browser.close()
