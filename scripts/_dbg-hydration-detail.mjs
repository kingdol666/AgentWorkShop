import puppeteer from 'puppeteer-core'
const ROOT = 'http://127.0.0.1:3100'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
const msgs = []
page.on('console', (m) => {
  const t = m.text()
  msgs.push(t.slice(0, 300))
})
await page.goto(`${ROOT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(7000)
console.log('mismatch 详情条数:', msgs.length)
msgs.slice(0, 6).forEach((m, i) => console.log(`--- #${i} ---\n${m}`))
await browser.close()
