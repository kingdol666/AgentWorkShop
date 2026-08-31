/**
 * 场景美化迭代截图/体检(2.5D Digital Twin):
 *  - 清空 device-twins → 铺薄膜产线 + 数采绑定(复用 _dbg-dt-interact 布局);
 *  - /town 多视角截图(std/top/front + 设备特写 dolly);
 *  - FPS 采样 + 设备状态环世界位置探针(诊断 ring 双重偏移)。
 * 用法: AW_PAGE_TOKEN=ut-xxx node scripts/_dbg-scene-polish-shot.mjs [tag]
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const TAG = process.argv[2] ?? 'shot'
const OUT = `docs/audit/screenshots/scene-polish-${TAG}`
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
if (!TOKEN) { console.error('need AW_PAGE_TOKEN'); process.exit(1) }

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
// 清空旧孪生(幂等重跑)
const listRes = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json()).catch(() => null)
const oldTwins = listRes?.data?.twins ?? listRes?.data?.items ?? listRes?.data ?? []
for (const t of oldTwins) {
  const id = t?.id ?? t?.twinId
  if (id) await fetch(`${BASE}/api/workshop/device-twins/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
}
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
  args: ['--no-sandbox', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
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
let ready = false
for (let i = 0; i < 40; i++) {
  ready = await page.evaluate(need => (window.__town?.scene?.agents?.size ?? 0) > 0 && (window.__town?.scene?.deviceNodes?.size ?? 0) >= need, created.length)
  if (ready) break
  await new Promise(r => setTimeout(r, 1000))
}
console.log('scene ready:', ready)
await new Promise(r => setTimeout(r, 4000))

import { mkdirSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

// 探针:设备状态环/数采光环世界位置 vs 设备根位置(诊断子体偏移)
const probe = await page.evaluate(() => {
  const s = window.__town?.scene
  if (!s) return null
  const out = []
  for (const d of (s.deviceNodes?.values?.() ?? [])) {
    out.push({
      name: d.name, root: { x: Math.round(d.root.position.x), z: Math.round(d.root.position.z) },
      ringLocal: { x: Math.round(d.ring.position.x), z: Math.round(d.ring.position.z) },
      isDaq: d.modelRef?.startsWith?.('daq-') ?? false,
    })
  }
  return out
})
console.log('probe:', JSON.stringify(probe))

// FPS 采样(2s)
const fps = await page.evaluate(() => new Promise((resolve) => {
  const s = window.__town?.scene
  if (!s) return resolve(-1)
  const a = s.frameCount
  setTimeout(() => resolve((s.frameCount - a) / 2), 2000)
}))
console.log('fps(headless):', fps)

await page.screenshot({ path: `${OUT}/view-std.png` })
await page.evaluate(() => window.__town?.scene?.setViewPreset?.('top'))
await new Promise(r => setTimeout(r, 1600))
await page.screenshot({ path: `${OUT}/view-top.png` })
await page.evaluate(() => {
  const s = window.__town?.scene
  s?.setViewPreset?.('std')
  s?.focusTo?.(1000, 1200)
  s?.zoomBy?.(-0.55)
})
await new Promise(r => setTimeout(r, 1800))
await page.screenshot({ path: `${OUT}/view-device-zoom.png` })
console.log('shots saved:', OUT)
console.log('pageerrors:', errors.length ? errors : 'none')
await browser.close()
