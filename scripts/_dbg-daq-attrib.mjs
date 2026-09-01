/** 归因实验:断网后主线程占用是否消失(区分 轮询churn vs 静态渲染成本)。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)
console.log('rows rendered:', await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length))

// 5s 在线基线
const on = await page.evaluate(() => new Promise((resolve) => {
  const t = { lt: 0, tot: 0 }
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { t.lt++; t.tot += e.duration } })
  po.observe({ entryTypes: ['longtask'] })
  setTimeout(() => { po.disconnect(); resolve({ lt: t.lt, tot: Math.round(t.tot) }) }, 5000)
}))

// 断网(轮询失败 + WS 断)后 5s
await page.setOfflineMode(true)
await sleep(1500)
const off = await page.evaluate(() => new Promise((resolve) => {
  const t = { lt: 0, tot: 0 }
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { t.lt++; t.tot += e.duration } })
  po.observe({ entryTypes: ['longtask'] })
  setTimeout(() => { po.disconnect(); resolve({ lt: t.lt, tot: Math.round(t.tot) }) }, 5000)
}))
console.log('在线 5s:', JSON.stringify(on), '| 断网 5s:', JSON.stringify(off))
await browser.close()
console.log('DONE')
