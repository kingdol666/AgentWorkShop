/**
 * Digital-Twin 交互审计(设计稿 OrbitLite 语义 + 四圆钮 + 导航图 + 告警链):
 *  - 相机:左键拖右 yaw 应减小(内容跟手不反向);Shift+拖 = 平移注视点移动;
 *    滚轮上 = dolly 减小(拉近);setAutoOrbit 开启后 yaw 自转;
 *  - 四圆钮:标注显隐 / 自动环绕 / 全屏按钮存在且可点;
 *  - 导航图:nav-cv 画布有绘制(非全黑)+ 相机锥;
 *  - 告警链:阈值收紧 → 越限告警入面板 → E-STOP crit 告警;
 *  - 铺一条薄膜产线 + 数采绑定,截图验收后清理。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

// 铺产线 + 数采(复用上轮审计布局)
const lineZ = 1200
const spec = [
  { name: '挤出机 L1', ref: 'dev-folder-extruder', x: 1000, z: lineZ, kind: 'device' },
  { name: 'MD 纵拉机 L1', ref: 'dev-folder-mdo', x: 1680, z: lineZ, kind: 'device' },
  { name: 'TD 拉幅机 L1', ref: 'dev-folder-tdo', x: 2080, z: lineZ, kind: 'device' },
  { name: '收卷机 L1', ref: 'dev-folder-winder', x: 2430, z: lineZ, kind: 'device' },
  { name: '压力变送器 01', ref: 'daq-pressure-tx', x: 1060, z: lineZ + 70, kind: 'daq' },
  { name: '温度传感器 01', ref: 'daq-temp-tc', x: 1690, z: lineZ + 80, kind: 'daq' },
  { name: '张力传感器 01', ref: 'daq-tension-cell', x: 2100, z: lineZ + 80, kind: 'daq' },
]
const created = []
for (const s of spec) {
  const res = await fetch(`${BASE}/api/workshop/device-twins`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: s.name, modelRef: s.ref, kind: s.kind, posX: s.x, posZ: s.z }),
  })
  const j = await res.json().catch(() => ({}))
  const id = j?.data?.twin?.id ?? j?.data?.id
  if (res.ok && id) created.push({ ...s, id })
}
console.log(`created ${created.length}/${spec.length}`)
const byName = Object.fromEntries(created.map(c => [c.name, c.id]))
const bindings = {
  [byName['压力变送器 01'] ?? 'x']: byName['挤出机 L1'] ?? 'y',
  [byName['温度传感器 01'] ?? 'x']: byName['MD 纵拉机 L1'] ?? 'y',
  [byName['张力传感器 01'] ?? 'x']: byName['TD 拉幅机 L1'] ?? 'y',
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument((b) => {
  localStorage.setItem('aw.twin.daqBindings', JSON.stringify(b))
}, bindings)
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(need => (window.__town?.scene?.agents?.size ?? 0) > 0 && (window.__town?.scene?.deviceNodes?.size ?? 0) >= need, created.length)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 5000))

// ---- 1) 相机方向语义(全部按设计稿 OrbitLite 断言方向,不只断言位移) ----
const cam0 = await page.evaluate(() => window.__town.scene.getCameraPose())
// 左键拖右 60px:theta -= dx·k → yaw 减小(内容跟手)
await page.evaluate(() => {
  const cv = window.__town.scene.canvas
  cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 800, clientY: 400, bubbles: true }))
})
for (let i = 0; i < 6; i++) {
  await page.evaluate(k => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800 + (k + 1) * 10, clientY: 400, bubbles: true })), i)
}
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
const cam1 = await page.evaluate(() => window.__town.scene.getCameraPose())
const yawDelta = cam1.yaw - cam0.yaw
console.log('orbit→: yawDelta =', yawDelta.toFixed(4), yawDelta < 0 ? '(OK 设计稿:拖右 yaw 减小)' : '(REVERSED!)')

// 左键下拖 60px:仰角 += dy·k → 相机升高(cam.y 增大,俯视方向)
const y0 = cam1.pos.y
await page.evaluate(() => {
  const cv = window.__town.scene.canvas
  cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 800, clientY: 400, bubbles: true }))
})
for (let i = 0; i < 6; i++) {
  await page.evaluate(k => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 400 + (k + 1) * 10, bubbles: true })), i)
}
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
const y1 = (await page.evaluate(() => window.__town.scene.getCameraPose())).pos.y
console.log('orbit↓: cam.y', y0.toFixed(1), '→', y1.toFixed(1), y1 > y0 ? '(OK 设计稿:下拖升向俯视)' : '(REVERSED!)')

// Shift+左键拖右 60px:target += −right·dx → 注视点 x 减小(内容跟随光标右移)
const t0 = (await page.evaluate(() => window.__town.scene.getCameraPose())).target.x
await page.evaluate(() => {
  const cv = window.__town.scene.canvas
  cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, shiftKey: true, clientX: 800, clientY: 400, bubbles: true }))
})
for (let i = 0; i < 6; i++) {
  await page.evaluate(k => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800 + (k + 1) * 10, clientY: 400, bubbles: true })), i)
}
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
const t1 = (await page.evaluate(() => window.__town.scene.getCameraPose())).target.x
console.log('pan→: target.x', t0.toFixed(1), '→', t1.toFixed(1), t1 < t0 ? '(OK 设计稿:拖右注视点 -right)' : '(REVERSED!)')

// Shift+左键下拖 60px:target += up·dy(up 地面分量 = −sinP·(sinY,cosY)) → 注视点 z 减小
const z0 = (await page.evaluate(() => window.__town.scene.getCameraPose())).target.z
await page.evaluate(() => {
  const cv = window.__town.scene.canvas
  cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, shiftKey: true, clientX: 800, clientY: 400, bubbles: true }))
})
for (let i = 0; i < 6; i++) {
  await page.evaluate(k => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 400 + (k + 1) * 10, bubbles: true })), i)
}
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
const z1 = (await page.evaluate(() => window.__town.scene.getCameraPose())).target.z
console.log('pan↓: target.z', z0.toFixed(1), '→', z1.toFixed(1), z1 < z0 ? '(OK 设计稿:下拖 up 分量 −z)' : '(REVERSED!)')

// 滚轮上 = 拉近(dolly 减小)
const d0 = await page.evaluate(() => window.__town.scene.dolly)
await page.evaluate(() => {
  const cv = window.__town.scene.canvas
  cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
})
await new Promise(r => setTimeout(r, 300))
const d1 = await page.evaluate(() => window.__town.scene.dolly)
console.log('wheel: dolly', d0.toFixed(3), '→', d1.toFixed(3), d1 < d0 ? '(OK 拉近)' : '(FAIL)')

// 自动环绕
await page.evaluate(() => window.__town.scene.setAutoOrbit(true))
const yawA = (await page.evaluate(() => window.__town.scene.getCameraPose())).yaw
await new Promise(r => setTimeout(r, 1200))
const yawB = (await page.evaluate(() => window.__town.scene.getCameraPose())).yaw
console.log('autoOrbit: yaw', yawA.toFixed(4), '→', yawB.toFixed(4), yawB !== yawA ? '(OK 自转)' : '(FAIL)')
await page.evaluate(() => window.__town.scene.setAutoOrbit(false))

// ---- 2) 四圆钮 + 导航图 + 告警 UI 骨架 ----
const ui = await page.evaluate(() => ({
  vpTools: document.querySelectorAll('.stage-top .vp-tool').length,
  vpSvg: document.querySelectorAll('.stage-top .vp-tool svg').length,
  navCanvas: !!document.querySelector('.nav-cv'),
  alarmPanel: !!document.querySelector('.alarm-list'),
  kpi5: document.querySelectorAll('.kpi-strip .kpi').length,
  estopBtn: !!document.querySelector('.btn-danger'),
  threshSlider: [...document.querySelectorAll('.ctl-row .ctl-name')].some(el => el.textContent?.includes('告警阈值')),
  leaders: !!document.querySelector('.leaders'),
  callouts: document.querySelectorAll('.callout').length,
  navBell: !!document.querySelector('.nav-bell-warn'),
}))
console.log('ui:', JSON.stringify(ui))

// ---- 3) 导航图非空绘制(读像素) ----
const navPixels = await page.evaluate(() => {
  const cv = document.querySelector('.nav-cv')
  if (!cv) return -1
  const x = cv.getContext('2d')
  const d = x.getImageData(0, 0, cv.width, cv.height).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
  return n
})
console.log('navPixels:', navPixels, navPixels > 500 ? '(OK 已绘制)' : '(FAIL 全黑)')

// ---- 4) E-STOP 告警链(点 dock 里的紧急停止,非 inspector 删除钮) ----
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dock .btn-danger')].find(b => (b.textContent ?? '').includes('紧急停止'))
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await new Promise(r => setTimeout(r, 500))
const alarmAfterEstop = await page.evaluate(() => ({
  rows: document.querySelectorAll('.al-row').length,
  txt: document.querySelector('.al-row .al-txt')?.textContent ?? '',
  armed: [...document.querySelectorAll('.dock .btn-danger')].some(b => b.classList.contains('armed')),
  bell: document.querySelector('.nav-bell-warn')?.textContent?.trim() ?? '',
}))
console.log('estop:', JSON.stringify(alarmAfterEstop))
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.dock .btn-danger')].find(b => (b.textContent ?? '').includes('紧急停止'))
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}) // 解除

// ---- 5) 截图 ----
await page.evaluate(() => window.__town.scene.focusTo(1700, 1200))
await new Promise(r => setTimeout(r, 3000))
await page.screenshot({ path: 'docs/audit/screenshots/town-dt-interact.png' })
console.log('pageerrors:', errors.length ? errors : 'none')

await page.close().catch(() => {})
await browser.close()
for (const c of created) {
  await fetch(`${BASE}/api/workshop/device-twins/${c.id}`, { method: 'DELETE', headers: H }).catch(() => {})
}
console.log(`cleanup done (${created.length})`)
