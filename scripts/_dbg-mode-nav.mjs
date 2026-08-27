/**
 * 运行/编辑只读锁 + 小地图同步 + 数采可视距离 审计:
 *  1) 运行模式:实体拖拽拒绝 / 投放拒绝+提示 / Inspector 只读(无删除、无绑定添加、名称禁用);
 *  2) 编辑模式:拖拽放行 / 投放成功 / Inspector 编辑控件在;
 *  3) 小地图与视角同步:zoomBy 后 meta ×N 变化(navScale=dolly),画布重绘;
 *  4) 数采可视距离滑杆:300 → 卡隐,3000 → 卡显(注视设备不变);
 *  5) 截图(编辑模式注视设备,堆叠卡 + 小地图)。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const spec = [
  { name: 'TD 拉幅机 L1', ref: 'dev-folder-tdo', x: 1700, z: 600, kind: 'device' },
  { name: '温度传感器 01', ref: 'daq-temp-tc', x: 1750, z: 690, kind: 'daq' },
  { name: '电参采集器 09', ref: 'daq-power-meter', x: 2900, z: 200, kind: 'daq' },
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
const byName = Object.fromEntries(created.map(c => [c.name, c.id]))
const bindings = { [byName['温度传感器 01']]: byName['TD 拉幅机 L1'] }
console.log(`created ${created.length}/${spec.length}`)

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
  localStorage.setItem('aw.twin.calloutNear', '1150')
}, bindings)
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(need => (window.__town?.scene?.deviceNodes?.size ?? 0) >= need, created.length)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 4000))

const twinCount = () => page.evaluate(() => window.__town.scene.deviceNodes.size)

// ---- 1) 运行模式(默认)锁 ----
// 拖拽门禁:设备「底面」屏幕点起手(y=0 → 射线回投地面即设备根位置)tryStartPointerDrag → false
const dragGate = await page.evaluate(() => {
  const s = window.__town.scene
  const dev = [...s.deviceNodes.values()].find(d => d.modelRef.includes('tdo'))
  const p = s.worldToScreen(dev.root.position.x, 0, dev.root.position.z)
  return s.tryStartPointerDrag(p.x, p.y)
})
console.log('run dragGate:', dragGate, dragGate === false ? '(OK 运行模式拒绝拖拽)' : '(FAIL 未锁)')

// 投放门禁:drop 数采 → 数量不变 + 只读提示
const before = await twinCount()
await page.evaluate(() => {
  const dt = new DataTransfer()
  dt.setData('application/x-aw-daq', 'pressure-tx')
  document.querySelector('#town-host canvas').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
})
await new Promise(r => setTimeout(r, 1200))
const afterDrop = await twinCount()
const hint = await page.evaluate(() => document.querySelector('.error-chip')?.textContent ?? '')
console.log('run drop:', before, '→', afterDrop, afterDrop === before ? '(OK 投放被拒)' : '(FAIL 漏放)', '| hint:', hint.includes('只读') ? '(OK 提示)' : '(FAIL 无提示)')

// Inspector 只读:选中设备 → 无删除钮/无绑定添加/名称禁用
await page.evaluate(() => {
  const s = window.__town.scene
  const dev = [...s.deviceNodes.values()].find(d => d.modelRef.includes('tdo'))
  s.setSelected({ kind: 'device', id: dev.twinId })
})
await new Promise(r => setTimeout(r, 600))
const ro = await page.evaluate(() => ({
  del: !!document.querySelector('.ins-del'),
  bindAdd: !!document.querySelector('.bind-add-wrap'),
  nameDisabled: document.querySelector('.obj-input')?.disabled ?? null,
}))
console.log('run inspector:', JSON.stringify(ro), !ro.del && !ro.bindAdd && ro.nameDisabled === true ? '(OK 只读)' : '(FAIL)')

// ---- 2) 切编辑(点顶栏 seg)→ 解锁 ----
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.topnav .seg button')].find(b => b.textContent?.includes('编辑'))
  btn?.click()
})
await new Promise(r => setTimeout(r, 500))
const dragGate2 = await page.evaluate(() => {
  const s = window.__town.scene
  const dev = [...s.deviceNodes.values()].find(d => d.modelRef.includes('tdo'))
  const p = s.worldToScreen(dev.root.position.x, 0, dev.root.position.z)
  const gate = s.tryStartPointerDrag(p.x, p.y)
  if (gate) s.endPointerDrag()
  return gate
})
await page.evaluate(() => {
  const dt = new DataTransfer()
  dt.setData('application/x-aw-daq', 'pressure-tx')
  document.querySelector('#town-host canvas').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
})
await new Promise(r => setTimeout(r, 1500))
const afterDrop2 = await twinCount()
const insp2 = await page.evaluate(() => ({
  del: !!document.querySelector('.ins-del'),
  nameDisabled: document.querySelector('.obj-input')?.disabled ?? null,
}))
console.log('edit: dragGate', dragGate2, dragGate2 ? '(OK)' : '(FAIL)', '| drop', afterDrop, '→', afterDrop2, afterDrop2 === before + 1 ? '(OK 投放成功)' : '(FAIL)', '| inspector:', JSON.stringify(insp2))

// ---- 3) 小地图与视角同步 ----
const meta0 = await page.evaluate(() => document.querySelector('.mm-meta')?.textContent ?? '')
await page.evaluate(() => {
  const s = window.__town.scene
  for (let i = 0; i < 2; i++) s.zoomBy(-0.2)
})
await new Promise(r => setTimeout(r, 600))
const meta1 = await page.evaluate(() => document.querySelector('.mm-meta')?.textContent ?? '')
const sync = meta0.match(/×([\d.]+)/)?.[1] ?? '?'
const sync1 = meta1.match(/×([\d.]+)/)?.[1] ?? '?'
console.log('navSync:', sync, '→', sync1, Number(sync1) < Number(sync) ? '(OK 小地图随视角缩放)' : '(FAIL)')

// ---- 4) 数采可视距离滑杆 ----
await page.evaluate(() => {
  const s = window.__town.scene
  s.focusTo(1700, 600)
})
await new Promise(r => setTimeout(r, 1800))
const nearOf = () => page.evaluate(() => [...document.querySelectorAll('.callout')].filter(c => c.classList.contains('near')).length)
const n0 = await nearOf()
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.dock .ctl-row')].find(r => r.textContent?.includes('数采可视距离'))?.querySelector('input')
  el.value = '300'
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await new Promise(r => setTimeout(r, 500))
const n1 = await nearOf()
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.dock .ctl-row')].find(r => r.textContent?.includes('数采可视距离'))?.querySelector('input')
  el.value = '3000'
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await new Promise(r => setTimeout(r, 500))
const n2 = await nearOf()
console.log('calloutDist: 1150→', n0, '张 | 300→', n1, '张 | 3000→', n2, '张',
  n0 >= 1 && n1 === 0 && n2 >= 1 ? '(OK 距离可控)' : '(FAIL)')
// 恢复默认并等一拍
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.dock .ctl-row')].find(r => r.textContent?.includes('数采可视距离'))?.querySelector('input')
  el.value = '1150'
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

// ---- 5) 截图(编辑模式注视设备)----
await new Promise(r => setTimeout(r, 600))
await page.screenshot({ path: 'docs/audit/screenshots/town-mode-nav.png' })
console.log('pageerrors:', errors.length ? errors : 'none')

await page.close().catch(() => {})
await browser.close()
for (const c of created) {
  await fetch(`${BASE}/api/workshop/device-twins/${c.id}`, { method: 'DELETE', headers: H }).catch(() => {})
}
console.log(`cleanup done (${created.length})`)
