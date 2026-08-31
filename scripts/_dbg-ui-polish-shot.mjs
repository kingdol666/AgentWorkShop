/** 一次性:UI 打磨基线 —— /daq /dcw /dcw-line 详情页截图 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const H = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }

const dcwLines = await fetch(`${BASE}/api/workshop/dcw/lines`, { headers: H }).then(r => r.json()).catch(() => null)
const lineId = dcwLines?.data?.lines?.[0]?.id ?? dcwLines?.data?.[0]?.id
console.log('line =', lineId)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

const OUT = 'docs/audit/screenshots/ui-polish-0831'
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: `${OUT}/daq-list.png` })
console.log('daq ok')

await page.goto(`${BASE}/dcw`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 5000))
await page.screenshot({ path: `${OUT}/dcw-list.png` })
console.log('dcw ok')

if (lineId) {
  await page.goto(`${BASE}/dcw/${lineId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 5000))
  await page.screenshot({ path: `${OUT}/dcw-line.png` })
  console.log('dcw-line ok')
}
await browser.close()
