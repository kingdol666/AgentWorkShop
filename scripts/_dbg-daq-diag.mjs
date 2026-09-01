/** /daq 诊断:视口截图 + console/pageerror 收集 + 主题状态。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
page.on('pageerror', e => errors.push(`PAGEERROR: ${String(e).slice(0, 200)}`))
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(7000)
console.log('html.dark present:', await page.evaluate(() => document.documentElement.classList.contains('dark')))
console.log('localStorage aw-theme:', await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.toLowerCase().includes('dark') || k.toLowerCase().includes('theme'))))))
console.log('header rect:', await page.evaluate(() => { const h = document.querySelector('header') ?? document.querySelector('.app-header'); return h ? JSON.stringify(h.getBoundingClientRect()) : 'none' }))
console.log('body scrollHeight:', await page.evaluate(() => document.body.scrollHeight))
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/daq-viewport.png' })
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
console.log('DONE')
