/** P7 目视验收截图:关键页面逐页截图到 .e2e-shots/p7-*.png,并汇总每页 console error。 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const ROOT = process.argv[2] ?? 'http://127.0.0.1:3001'
const EMAIL = process.argv[3] ?? 'admin@awshop.local'
const PASS = process.argv[4] ?? 'admin123'
const OUT = '.e2e-shots'
mkdirSync(OUT, { recursive: true })

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) }).then(r => r.json())
if (!login?.data?.token) { console.error('LOGIN FAIL'); process.exit(1) }

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: new URL(ROOT).hostname, path: '/' })

const pages = [
  ['workshop', '/workshop', 9000],
  ['daq', '/daq', 12000],
  ['dcw', '/dcw', 9000],
  ['town', '/town', 20000],
  ['settings', '/settings', 9000],
  ['monitor', '/monitor', 9000],
  ['aml', '/aml', 9000],
  ['logs', '/logs', 9000],
  ['users', '/users', 9000],
]
const summary = []
for (const [name, path, wait] of pages) {
  const errors = []
  const onConsole = (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)) }
  page.on('console', onConsole)
  try {
    await page.goto(`${ROOT}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await new Promise(r => setTimeout(r, wait))
    const file = `${OUT}/p7-${name}.png`
    await page.screenshot({ path: file })
    summary.push({ name, ok: true, errors })
    console.log(`✓ ${name} → ${file}${errors.length ? ` (console errors: ${errors.length})` : ''}`)
  } catch (e) {
    summary.push({ name, ok: false, errors: [String(e).slice(0, 120)] })
    console.log(`✖ ${name}: ${String(e).slice(0, 120)}`)
  }
  page.off('console', onConsole)
}
// daq 详情页(从列表第一个 console-link 进入)
try {
  await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 10000))
  const href = await page.evaluate(() => document.querySelector('.nodes-table .console-link')?.getAttribute('href'))
  if (href) {
    await page.goto(`${ROOT}${href}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await new Promise(r => setTimeout(r, 8000))
    await page.screenshot({ path: `${OUT}/p7-daq-detail.png` })
    console.log(`✓ daq-detail → ${OUT}/p7-daq-detail.png`)
  }
} catch (e) { console.log(`✖ daq-detail: ${String(e).slice(0, 100)}`) }
await browser.close()
const bad = summary.filter(s => !s.ok || s.errors.length)
console.log(`\n页面数=${summary.length} 有问题页=${bad.length}`)
for (const b of bad) console.log(' -', b.name, b.errors.slice(0, 2).join(' | '))
