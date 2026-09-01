import puppeteer from 'puppeteer-core'
const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
const optReq = []
page.on('request', r => { if (r.url().includes('/dcw/optimizations')) optReq.push(r.url()) })
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(8000)
await page.click('.opt-head')
await sleep(800)
const before = optReq.length
await page.evaluate(() => {
  const sel = document.querySelectorAll('.opt-filters select')[1]
  sel.value = sel.options[1].value
  sel.dispatchEvent(new Event('change'))
})
await sleep(1500)
const hit = optReq.slice(before).find(u => u.includes('recipeId='))
const rows = await page.evaluate(() => document.querySelectorAll('.opt-list .opt-row').length)
if (hit) console.log('PASS Recipe 筛选:', hit.split('/api')[1], '| 过滤后记录:', rows)
else { console.error('FAIL no recipeId request; got:', JSON.stringify(optReq.slice(before))); process.exitCode = 1 }
// 截图:优化记录面板 + 筛选工具条全貌
const el = await page.$('.page')
await el.screenshot({ path: 'docs/audit/screenshots/redesign0831/daq-opt-recipe.png' })
await browser.close()
console.log(process.exitCode ? 'FAILED' : 'DONE')
