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
const patches = []
page.on('response', (r) => {
  if (r.request().method() === 'PATCH' && r.url().includes('/device-twins/')) patches.push(r.status())
})
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!window.__town?.scene?.agents?.size)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 3500))

// 1) 编辑模式 + 选中设备 → 手柄附身
// 走真实 UI:点击「编辑」按钮(toggleMode 同步 TownView mode + scene 模式)
await page.click('.mode-bar .mode-btn')
await new Promise(r => setTimeout(r, 400))
const r1 = await page.evaluate(async () => {
  const s = window.__town.scene
  const dev = s.getDeviceNodes()[0]
  if (!dev) return { fail: 'no device' }
  s.setSelected({ kind: 'device', id: dev.twinId })
  window.__devId = dev.twinId
  await new Promise(r => setTimeout(r, 300))
  const tc = s.tControls
  return {
    attached: !!tc?.object,
    sameObject: tc?.object === s.deviceNodes.get(dev.twinId)?.root,
    mode: tc?.mode,
    toolbar: [...document.querySelectorAll('.mode-bar .seg-btn')].map(b => b.textContent.trim()),
  }
})
console.log('attach:', JSON.stringify(r1))

// 2) 键盘 G/R/S → 模式切换 + 轴约束
const r2 = await page.evaluate(() => {
  const s = window.__town.scene
  const out = {}
  for (const [key, want] of [['g', 'translate'], ['r', 'rotate'], ['s', 'scale']]) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    const tc = s.tControls
    out[key] = { mode: tc.mode, showX: tc.showX, showY: tc.showY, showZ: tc.showZ, ok: tc.mode === want }
  }
  return out
})
console.log('keys:', JSON.stringify(r2))

// 3) 手柄拖拽落库:模拟 dragging-changed + 位移(等价 gizmo 拖 X 轴)
const r3 = await page.evaluate(() => {
  const s = window.__town.scene
  const tc = s.tControls
  const dev = s.deviceNodes.get(window.__devId)
  window.__before = { x: Math.round(dev.root.position.x), z: Math.round(dev.root.position.z) }
  tc.dispatchEvent({ type: 'dragging-changed', value: true })
  dev.root.position.x += 220
  dev.root.position.z -= 140
  tc.dispatchEvent({ type: 'dragging-changed', value: false })
  const n = s.getDeviceNodes().find(d => d.twinId === window.__devId)
  return { after: { x: n.x, z: n.z } }
})
await new Promise(r => setTimeout(r, 700))
console.log('gizmo drag:', JSON.stringify({ before: r3.after ? (await Promise.resolve()) : null }))
console.log('full r3:', JSON.stringify(r3), '| before:', JSON.stringify(await page.evaluate(() => window.__before)), '| PATCH:', patches)

// 4) 无级缩放:dolly 0.002 / 300,相机 near/far 动态,场景不崩
const r4 = await page.evaluate(async () => {
  const s = window.__town.scene
  const out = {}
  s.zoomBy(-5)
  await new Promise(r => setTimeout(r, 400))
  out.close = { dolly: +s.dolly.toFixed(3), near: +s.camera.near.toFixed(3), far: Math.round(s.camera.far) }
  s.zoomBy(300)
  await new Promise(r => setTimeout(r, 400))
  out.far2 = { dolly: +s.dolly.toFixed(1), near: +s.camera.near.toFixed(0), far: Math.round(s.camera.far) }
  return out
})
console.log('unlimited zoom:', JSON.stringify(r4))
console.log('errors:', errors.slice(0, 5))
await page.evaluate(() => {
  window.__town.scene.zoomBy(-298.9)
})
await new Promise(r => setTimeout(r, 500))
await page.screenshot({ path: 'docs/audit/screenshots/gizmo.png' })
await browser.close()
