/** 全站巡检截图:8 个主页面一次采齐。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
if (!login.data?.token) { console.error('login failed'); process.exit(1) }

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

const shots = [
  ['/', 'audit-home'],
  ['/daq', 'audit-daq'],
  ['/dcw', 'audit-dcw'],
  ['/workshop', 'audit-workshop'],
  ['/monitor', 'audit-monitor'],
  ['/users', 'audit-users'],
  ['/settings', 'audit-settings'],
]
for (const [path, name] of shots) {
  try {
    await page.goto(`${ROOT}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(name === 'audit-workshop' ? 9000 : 5000)
    await page.screenshot({ path: `docs/audit/screenshots/redesign0831/${name}.png`, fullPage: name !== 'audit-workshop' })
    console.log('ok', name)
  } catch (e) {
    console.error('FAIL', name, e.message.slice(0, 80))
  }
}
await browser.close()
console.log('DONE')
