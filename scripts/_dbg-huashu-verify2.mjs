/** 一次性:身份色色相桶 + DCW 图底卡片 —— 修后验证截图 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-3b8495cf61b34bd4b3c0e02fc242fc66'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(`[pageerror] ${String(e).slice(0, 160)}`))
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

await page.goto('http://127.0.0.1:3000/dcw', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 8000))
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/after-dcw.png' })
console.log('shot: dcw')

await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 28000))
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/after-town.png' })
console.log('shot: town')
await browser.close()
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors')
