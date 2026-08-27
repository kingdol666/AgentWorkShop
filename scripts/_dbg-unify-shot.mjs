/** 一次性:全站页面截图(控制室暗色统一化验证)——登录态 + 各主路由 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'

// 登录拿会话 token(种子管理员)
const loginRes = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = loginRes?.data?.token
if (!token) throw new Error(`login failed: ${JSON.stringify(loginRes).slice(0, 200)}`)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

const PAGES = [
  ['dashboard', '/'],
  ['workshop', '/workshop'],
  ['town', '/town'],
  ['tokens', '/tokens'],
  ['users', '/users'],
  ['monitor', '/monitor'],
  ['settings', '/settings'],
]

for (const [name, path] of PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, name === 'town' ? 8000 : 3200))
  await page.screenshot({ path: `docs/audit/screenshots/unify-${name}.png` })
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  console.log(`${name}: dark=${dark}`)
}

await browser.close()
console.log('shots ok')
