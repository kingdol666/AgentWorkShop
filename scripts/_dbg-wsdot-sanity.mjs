import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const OUT = 'docs/audit/screenshots/ui-polish-0831'
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
const issues = []
page.on('pageerror', (e) => issues.push(String(e).slice(0, 150)))
await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle0', timeout: 90000 })
await new Promise(r => setTimeout(r, 5000))
const dot = await page.evaluate(() => {
  const el = document.querySelector('.ws-dot')
  if (!el) return { present: false }
  return { present: true, cls: el.className, title: el.title }
})
console.log('ws-dot on /workshop:', JSON.stringify(dot))
await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle0', timeout: 90000 })
await new Promise(r => setTimeout(r, 5000))
const daqErr = await page.evaluate(() => !!document.querySelector('.ant-alert, [class*=error]'))
console.log('/daq loads, error-banner present only if error:', daqErr)
await page.screenshot({ path: `${OUT}/final-daq-page.png` })
console.log('page errors:', issues.length, issues.slice(0, 3))
await browser.close()
