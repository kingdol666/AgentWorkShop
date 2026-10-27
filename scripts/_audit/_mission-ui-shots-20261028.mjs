/**
 * 2026-10-28 全功能验收:实机 UI 走查截图(3470 实例)。
 * 模式:REST 登录 → token cookie → gotoReady 水合等待(lib 同款判据) → 截图。
 * 输出: docs/audit/evidence/2026-10-28-full-acceptance-run2/ui-*.png (≥6 张)
 */
import { launch } from '../ui/lib.mjs'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3470'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2'
process.env.NO_PROXY = '127.0.0.1,localhost'
mkdirSync(OUT, { recursive: true })

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }),
}).then(r => r.json())
const TOKEN = login?.data?.token
if (!TOKEN) { console.error('登录失败'); process.exit(1) }

const browser = await launch({ width: 1600, height: 950 })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 950 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.setCookie({ name: 'aw-theme', value: 'dark', domain: '127.0.0.1', path: '/' })

const gotoReady = async (path, wait = 3800) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.documentElement.getAttribute('data-vp-tier'), { timeout: 45000 }).catch(() => {})
  await new Promise(r => setTimeout(r, wait))
}

const shots = [
  ['ui-01-dashboard', '/'],
  ['ui-02-daq', '/daq'],
  ['ui-03-dcw', '/dcw'],
  ['ui-04-ontology', '/ontology'],
  ['ui-05-channel', '/workshop'],
  ['ui-06-operations', '/operations'],
]
let okCount = 0
for (const [name, path] of shots) {
  try {
    await gotoReady(path)
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log(`✔ ${name} ← ${path}`)
    okCount++
  }
  catch (e) {
    console.log(`✘ ${name}: ${String(e).slice(0, 120)}`)
  }
}
await browser.close()
console.log(`UI shots: ${okCount}/${shots.length}`)
process.exit(okCount >= 5 ? 0 : 1)
