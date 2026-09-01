import puppeteer from 'puppeteer-core'
const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
const errors = []
const optReq = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })
page.on('pageerror', e => errors.push(`PAGEERROR: ${String(e).slice(0, 160)}`))
page.on('request', r => { if (r.url().includes('/dcw/optimizations')) optReq.push(r.url()) })
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(8000)
console.log('opt requests after load:', optReq.length, optReq[0]?.split('/api')[1] ?? '')
console.log('opt-head exists:', await page.evaluate(() => !!document.querySelector('.opt-head')))
await page.click('.opt-head')
await sleep(1500)
console.log('opt requests after click:', optReq.length, optReq.at(-1)?.split('/api')[1] ?? '')
console.log('rows:', await page.evaluate(() => document.querySelectorAll('.opt-list .opt-row').length),
  '| empty hint:', await page.evaluate(() => document.querySelector('.opt-body .opt-empty')?.textContent.trim() ?? 'none'),
  '| body exists:', await page.evaluate(() => !!document.querySelector('.opt-body')))
console.log('recipe select options:', await page.evaluate(() => document.querySelectorAll('.opt-filters select')[1]?.options.length ?? 'no-select'))
console.log('errors:', errors.length ? errors.slice(0, 4) : 'none')
await browser.close()
console.log('DONE')
