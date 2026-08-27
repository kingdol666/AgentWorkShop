/** 一次性:首页客户端报错捕获(pageerror + console.error) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (err) => {
  errors.push(`[pageerror] ${String(err?.message ?? err).slice(0, 500)}`)
})
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    errors.push(`[console.${msg.type()}] ${msg.text().slice(0, 400)}`)
  }
})
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 6000))
console.log(errors.length ? errors.join('\n---\n') : '(no client errors)')
await browser.close()
