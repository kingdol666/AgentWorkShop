/** 一次性:hero outline 按钮计算样式探针 */
import puppeteer from 'puppeteer-core'
const TOKEN = 'ut-3b8495cf61b34bd4b3c0e02fc242fc66'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 9000))
const probe = await page.evaluate(() => {
  const btn = document.querySelector('.hero-acts .aw-pill.outline')
  if (!btn) return 'not found'
  const cs = getComputedStyle(btn)
  return { border: cs.borderColor, bg: cs.backgroundColor, color: cs.color }
})
console.log(JSON.stringify(probe))
await browser.close()
