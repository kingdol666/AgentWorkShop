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
const puts = []
page.on('request', (r) => {
  if (r.method() === 'PUT' && r.url().includes('/scene/layouts/')) puts.push(r.url())
  if (r.method() === 'PATCH' && r.url().includes('/device-twins/')) puts.push(r.url())
})

await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!window.__town?.scene?.agents?.size)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 2500))

// 标定:屏幕中点世界坐标 + 牛顿精化投影(挂到 window.__tsE)
await page.evaluate(() => {
  const s = window.__town.scene
  const r = s.canvas.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const c = s.screenToWorld(cx, cy)
  const ex = s.screenToWorld(cx + 100, cy)
  const ez = s.screenToWorld(cx, cy + 100)
  const ax = { x: (ex.x - c.x) / 100, z: (ex.z - c.z) / 100 }
  const ay = { x: (ez.x - c.x) / 100, z: (ez.z - c.z) / 100 }
  const det = ax.x * ay.z - ax.z * ay.x
  window.__tsA = (wx, wz) => [
    cx + ((wx - c.x) * ay.z - (wz - c.z) * ay.x) / det,
    cy + ((wz - c.z) * ax.x - (wx - c.x) * ax.z) / det,
  ]
  window.__tsE = (wx, wz) => {
    let [sx, sy] = window.__tsA(wx, wz)
    for (let i = 0; i < 3; i++) {
      const w = s.screenToWorld(sx, sy)
      const [rx, ry] = window.__tsA(w.x, w.z)
      sx += sx - rx
      sy += sy - ry
    }
    return [sx, sy]
  }
})

// ===== A) pickBeacon API 层 =====
const a = await page.evaluate(() => {
  const s = window.__town.scene
  const b = [...s.blocks.values()][1]
  window.__cid = b.channelId
  return {
    hit: s.pickBeacon(b.x, b.z),
    beacon: !!b.beacon,
  }
})
console.log('A pickBeacon:', JSON.stringify(a))

// ===== B) 信标点击(pointerup 派发到活 canvas;镜头已对准领地中心 → 信标在屏幕正中) =====
await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  s.focusTo(b.x, b.z)
})
await new Promise(r => setTimeout(r, 1000))
await page.evaluate(() => {
  const s = window.__town.scene
  const rect = s.canvas.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  // 按下(守卫需要)+ 松手,位移 0 = 点击
  s.canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, bubbles: true }))
  s.canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: cx, clientY: cy, button: 0, bubbles: true }))
})
await new Promise(r => setTimeout(r, 1100))
const cidNow = await page.evaluate(() => window.__cid)
const b3 = await page.evaluate(cid => ({
  sel: window.__town.scene.selectedChannel === cid,
  panel: !!document.querySelector('.boundary-panel'),
  cam: window.__town.scene.getCameraTarget(),
}), cidNow)
console.log('B beacon click:', JSON.stringify(b3))

// ===== C) 无边界:频道拖到旧世界边界外(focusTo 精确屏幕中心法) =====
await page.evaluate(() => {
  window.__town.scene.setMode('edit')
})
await new Promise(r => setTimeout(r, 300))
const c1 = await page.evaluate(() => {
  const s = window.__town.scene
  const b = s.blocks.get(window.__cid)
  const members = [...s.agents.values()].filter(x => x.channelId === b.channelId)
  let P = null
  for (let ang = 0; ang < 360 && !P; ang += 10) {
    const px = b.x + Math.cos(ang * Math.PI / 180) * b.radiusX * 0.5
    const pz = b.z + Math.sin(ang * Math.PI / 180) * b.radiusZ * 0.5
    if (Math.hypot(px - b.x, pz - b.z) < 90) continue
    if (members.every(m => Math.hypot(m.root.position.x - px, m.root.position.z - pz) > 110)) P = { x: px, z: pz }
  }
  if (!P) return { fail: 'no clear point' }
  s.focusTo(P.x, P.z)
  window.__P = P
  return { P, before: { x: b.x, z: b.z } }
})
console.log('C clear point:', JSON.stringify(c1))
if (!c1.fail) {
  await new Promise(r => setTimeout(r, 1000))
  const c2 = await page.evaluate(() => {
    const s = window.__town.scene
    const rect = s.canvas.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    // 屏幕中心世界点 = camTarget = P(focusTo 精确);由此启动频道拖拽
    const started = s.tryStartPointerDrag(cx, cy)
    if (!started) return { started: false, worldAtCenter: s.screenToWorld(cx, cy) }
    // 拖拽中:把注视点移到 (P + 1500, P + 700),等待补间后屏幕中心即该点
    const P = window.__P
    s.focusTo(P.x + 1500, P.z + 700)
    return { started: s.isPointerDragging() }
  })
  console.log('C drag started:', JSON.stringify(c2))
  if (c2.started) {
    await new Promise(r => setTimeout(r, 1100))
    await page.evaluate(() => {
      const s = window.__town.scene
      const rect = s.canvas.getBoundingClientRect()
      s.movePointerDrag(rect.left + rect.width / 2, rect.top + rect.height / 2)
      s.endPointerDrag()
    })
    await new Promise(r => setTimeout(r, 600))
    const c3 = await page.evaluate((cid) => {
      const b = window.__town.scene.blocks.get(cid)
      return { x: Math.round(b.x), z: Math.round(b.z) }
    }, await page.evaluate(() => window.__cid))
    console.log('C after drag:', JSON.stringify(c3), '| x beyond old 3200:', c3.x > 3200, '| expect ~', Math.round(c1.before.x + c1.P ? (c1.P.x + 1500 - c1.P.x) : 0))
  }
}

// ===== D) 设备任意摆放:拖设备到远处 + PATCH 落库 =====
const d1 = await page.evaluate(() => {
  const s = window.__town.scene
  const nodes = s.getDeviceNodes()
  if (!nodes.length) return { fail: `no device nodes (twins poll may pending)` }
  const n = nodes[0]
  const [sx, sy] = window.__tsE(n.root.position.x, n.root.position.z)
  const ok = s.tryStartPointerDrag(sx, sy)
  return { ok, from: { x: Math.round(n.root.position.x), z: Math.round(n.root.position.z) } }
})
console.log('D device drag start:', JSON.stringify(d1))
if (d1.ok) {
  await page.evaluate(() => {
    const s = window.__town.scene
    const n = s.getDeviceNodes()[0]
    if (!n) return
    for (let i = 1; i <= 8; i++) {
      const [mx, my] = window.__tsE(n.root.position.x + 100, n.root.position.z + 62.5)
      s.movePointerDrag(mx, my)
    }
  })
  await page.evaluate(() => {
    window.__town.scene.endPointerDrag()
  })
  await new Promise(r => setTimeout(r, 600))
  const d2 = await page.evaluate(() => {
    const n = window.__town.scene.getDeviceNodes()[0]
    return n ? { to: { x: Math.round(n.root.position.x), z: Math.round(n.root.position.z) } } : { fail: 'gone' }
  })
  console.log('D device after drag:', JSON.stringify(d2))
}
console.log('requests(PUT layout/PATCH twin):', puts.length, puts.slice(0, 3))
console.log('errors:', errors.slice(0, 5))
await page.screenshot({ path: 'docs/audit/screenshots/beacon-unbounded.png' })
await browser.close()
