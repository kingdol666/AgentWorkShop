/** 一次性截图:仪表盘(/)与数字孪生(/town)当前视觉现状。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
if (!login.data?.token) { console.error('login failed', JSON.stringify(login).slice(0, 200)); process.exit(1) }

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

await page.goto(`${ROOT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(9000)
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/dash-after3.png', fullPage: true })
console.log('dash shot ok')

await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(22000)
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-after3.png' })
console.log('town shot ok')

await browser.close()
console.log('DONE')
