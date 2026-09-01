import puppeteer from 'puppeteer-core'
const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
const errs = []
page.on('pageerror', e => errs.push(`PAGEERROR: ${String(e).slice(0, 300)}`))
page.on('console', (m) => { if (m.type() === 'error') errs.push(`CONSOLE: ${m.text().slice(0, 300)}`) })
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)
console.log('rows:', await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length))
console.log('toolbar 存在:', await page.evaluate(() => !!document.querySelector('.tbl-toolbar')),
  '| 模板下拉存在:', await page.evaluate(() => !!document.querySelector('.flt-search')),
  '| KPI/横幅存在:', await page.evaluate(() => !!document.querySelector('.page')))
console.log('count 文本:', await page.evaluate(() => document.querySelector('.count')?.textContent ?? 'none'))
console.log('errors:', errs.length ? errs.slice(0, 6) : 'none')
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/daq-debug.png' })
await browser.close()
console.log('DONE')
