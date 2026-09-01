/** 验证:/dcw 筛选交互 + 仪表盘亮色模式。 */
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

// ---- A. /dcw 筛选 ----
const p1 = await browser.newPage()
await p1.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await p1.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await p1.goto(`${ROOT}/dcw`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(6000)
const cardCount = () => p1.evaluate(() => document.querySelectorAll('.line-grid .line-card:not(.new-card)').length)
console.log('[dcw] all cards:', await cardCount())
const segBtns = await p1.$$('.fleet-filter .aw-seg button')
console.log('[dcw] seg labels:', await p1.evaluate(() => [...document.querySelectorAll('.fleet-filter .aw-seg button')].map(b => b.textContent.trim())))
await segBtns[1].click()
await sleep(500)
console.log('[dcw] running filter cards:', await cardCount())
await segBtns[0].click()
await sleep(400)
await p1.type('.fleet-search', '1号')
await sleep(600)
console.log('[dcw] search「1号」cards:', await cardCount())
await p1.evaluate(() => { document.querySelector('.fleet-search').value = '' })
await p1.click('.fleet-filter .aw-seg button')
await sleep(600)
const hd = await p1.$('.page')
await hd.screenshot({ path: 'docs/audit/screenshots/redesign0831/dcw-filter.png' })

// ---- B. 仪表盘亮色 ----
const p2 = await browser.newPage()
await p2.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await p2.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await p2.evaluateOnNewDocument(() => localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: null })))
await p2.goto(`${ROOT}/`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(9000)
console.log('[light] html.dark:', await p2.evaluate(() => document.documentElement.classList.contains('dark')))
await p2.screenshot({ path: 'docs/audit/screenshots/redesign0831/dash-light.png' })

await browser.close()
console.log('DONE')
