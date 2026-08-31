/** 一次性:仪表盘(/)空白排查 —— console 捕获 + DOM 高度检查 */
import puppeteer from 'puppeteer-core'

const loginRes = await fetch('http://127.0.0.1:3000/api/users/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = loginRes?.data?.token
if (!token) throw new Error('login failed')

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
  const t = msg.type()
  if (t === 'error' || t === 'warning') {
    const text = msg.text()
    if (/vue-devtools|Download the Vue Devtools/i.test(text)) return
    issues.push(`[${t}] ${text.slice(0, 250)}`)
  }
})
page.on('pageerror', (err) => issues.push(`[pageerror] ${String(err).slice(0, 300)}`))

await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))

const info = await page.evaluate(() => {
  const main = document.querySelector('.ant-layout-content') || document.querySelector('main')
  const charts = document.querySelectorAll('canvas').length
  const bodyText = (main?.innerText || document.body.innerText || '').slice(0, 300)
  return {
    contentHeight: main?.getBoundingClientRect().height ?? -1,
    canvases: charts,
    bodyText,
  }
})
console.log(JSON.stringify(info, null, 2))
console.log('--- console issues:', issues.length)
issues.slice(0, 15).forEach(i => console.log(i))
await page.screenshot({ path: 'docs/audit/screenshots/ui-polish-0831/dash-probe.png' })
await browser.close()
