/**
 * callout 距离显隐 + 堆叠审计(阈值 1150,3D 距离):
 *  - 设备放在远离世界中心处;overview(注视世界中心)→ 设备距相机 ~1600 → 全隐;
 *  - focusTo 设备(dolly 1)→ 注视设备 ~1046 < 1150 → 2 路绑定卡浮现,竖排 104;
 *  - 视线移开(focusTo 远角)→ 复隐;截图 = 注视近景。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const spec = [
  { name: 'TD 拉幅机 L1', ref: 'dev-folder-tdo', x: 1700, z: 600, kind: 'device' },
  { name: '温度传感器 01', ref: 'daq-temp-tc', x: 1750, z: 690, kind: 'daq' },
  { name: '张力传感器 01', ref: 'daq-tension-cell', x: 1650, z: 690, kind: 'daq' },
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
console.log(`created ${created.length}/${spec.length}`)
const byName = Object.fromEntries(created.map(c => [c.name, c.id]))
const devId = byName['TD 拉幅机 L1']
const bindings = {
  [byName['温度传感器 01']]: devId,
  [byName['张力传感器 01']]: devId,
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
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(need => (window.__town?.scene?.deviceNodes?.size ?? 0) >= need, created.length)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 4000))

const state = () => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.callout')]
  const near = cards.filter(c => c.classList.contains('near'))
  return {
    total: cards.length,
    near: near.length,
    ys: near.map(c => c.style.top),
  }
})

// 1) overview(注视世界中心):设备在远处 → 全隐
await page.evaluate(() => window.__town.scene.resetView())
await new Promise(r => setTimeout(r, 2200))
const s0 = await state()
console.log('overview:', JSON.stringify(s0), s0.near === 0 ? '(OK 远距全隐)' : '(FAIL 未隐)')

// 2) 注视设备(dolly 1,~1046 < 1150)→ 2 卡浮现 + 104 堆叠
await page.evaluate(() => window.__town.scene.focusTo(1700, 600))
await new Promise(r => setTimeout(r, 1800))
const s1 = await state()
const ys = s1.ys.map(v => Number.parseFloat(v)).sort((a, b) => a - b)
const stackDelta = ys.length >= 2 ? Math.round(ys[ys.length - 1] - ys[0]) : -1
console.log('focus:', JSON.stringify(s1), 'stackDelta:', stackDelta,
  s1.near === 2 && stackDelta === 104 ? '(OK 注视浮现+104 堆叠)' : '(FAIL)')

// 3) 视线移开(看向远处数采杆)→ 注视谁谁亮:TD 的 2 张绑定卡复隐,远处数采自身的卡亮起
await page.evaluate(() => window.__town.scene.focusTo(2900, 200))
await new Promise(r => setTimeout(r, 1800))
const s2 = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.callout')]
  return {
    nearLabels: cards.filter(c => c.classList.contains('near')).map(c => c.querySelector('.co-label')?.textContent?.trim() ?? ''),
    tdBoundNear: cards.filter(c => (c.textContent ?? '').includes('TD 拉幅机') && c.classList.contains('near')).length,
  }
})
console.log('away:', JSON.stringify(s2),
  s2.nearLabels.length === 1 && s2.tdBoundNear === 0 ? '(OK 注视谁谁亮,原绑定卡复隐)' : '(FAIL)')

// 4) 回注视 → 近景截图(堆叠卡 + 引线)
await page.evaluate(() => window.__town.scene.focusTo(1700, 600))
await new Promise(r => setTimeout(r, 1800))
const s3 = await state()
console.log('refocus:', JSON.stringify(s3))
await page.screenshot({ path: 'docs/audit/screenshots/town-callout-near.png' })
console.log('pageerrors:', errors.length ? errors : 'none')

await page.close().catch(() => {})
await browser.close()
for (const c of created) {
  await fetch(`${BASE}/api/workshop/device-twins/${c.id}`, { method: 'DELETE', headers: H }).catch(() => {})
}
console.log(`cleanup done (${created.length})`)
