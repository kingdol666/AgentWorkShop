/** 一次性:PaneSplitter 编译修复验证 —— /workshop 与工作台控制台均无编译错误 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const OUT = 'docs/audit/screenshots/ui-polish-0831'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

const issues = []
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text()
    if (/vue-devtools|Download the Vue Devtools/i.test(text)) return
    issues.push(`[console.error] ${text.slice(0, 200)}`)
  }
})
page.on('pageerror', (err) => issues.push(`[pageerror] ${String(err).slice(0, 250)}`))

// 1) /workshop
await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle0', timeout: 90000 })
await new Promise(r => setTimeout(r, 4000))
const overlay1 = await page.evaluate(() => !!document.querySelector('vite-error-overlay'))
console.log('/workshop vite-error-overlay:', overlay1)
await page.screenshot({ path: `${OUT}/fix-workshop.png` })

// 2) 进入控制台(挂 MultiChannelView → PaneSplitter)
const enter = await page.$('a, button')
const link = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, a')]
  const b = btns.find(x => /进入控制台/.test(x.innerText || ''))
  return b ? true : false
})
if (link) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, a')].find(x => /进入控制台/.test(x.innerText || ''))
    b.click()
  })
  await new Promise(r => setTimeout(r, 6000))
}
const path2 = await page.evaluate(() => location.pathname)
const overlay2 = await page.evaluate(() => !!document.querySelector('vite-error-overlay'))
const splitter = await page.evaluate(() => document.querySelectorAll('.pane-splitter').length)
console.log('after enter:', path2, '| vite-error-overlay:', overlay2, '| pane-splitter count:', splitter)
await page.screenshot({ path: `${OUT}/fix-workshop-console.png` })

console.log('console issues:', issues.length)
issues.slice(0, 8).forEach(i => console.log(i))
await browser.close()
console.log('done')
