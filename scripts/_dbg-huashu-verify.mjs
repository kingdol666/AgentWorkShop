/** 一次性:huashu 美化轮验证 —— /town(含进场后稳态)与 /dcw 截图 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.setViewport({ width: 1920, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 24000))
await page.screenshot({ path: 'docs/audit/screenshots/huashu-after-town.png' })

await page.goto('http://127.0.0.1:3000/dcw', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: 'docs/audit/screenshots/huashu-after-dcw.png' })

await browser.close()
console.log(errors.length ? `PAGEERRORS: ${errors.join(' | ')}` : 'no page errors')
