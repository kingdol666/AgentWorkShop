// 全页面基线/对比截图
import puppeteer from 'puppeteer-core'
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001'
const TAG = process.argv[3] ?? 'base'
const PAGES = [
  ['dashboard', '/'],
  ['workshop', '/workshop'],
  ['daq', '/daq'],
  ['dcw', '/dcw'],
  ['tokens', '/tokens'],
  ['permissions', '/permissions'],
  ['plugins', '/plugins'],
  ['logs', '/logs'],
  ['monitor', '/monitor'],
  ['settings', '/settings'],
]
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
await page.setCookie({ name: 'token', value: login.data.token, domain: new URL(BASE).hostname, path: '/' })
for (const [name, path] of PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 2500))
  await page.screenshot({ path: `.e2e-shots/ui-${TAG}-${name}.png` })
  console.log(`📷 ${TAG}-${name}`)
}
await browser.close()
