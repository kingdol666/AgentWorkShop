/** 一次性:首页 12s 长等待截图(判别冷启动水合延迟 vs 真渲染缺陷) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
const errors = []
page.on('pageerror', err => errors.push(String(err?.message ?? err).slice(0, 300)))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[c] ${msg.text().slice(0, 300)}`)
})
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 12000))
await page.screenshot({ path: 'docs/audit/screenshots/probe-dashboard-12s.png' })
console.log('errors:', JSON.stringify(errors.slice(0, 5)))
await browser.close()
