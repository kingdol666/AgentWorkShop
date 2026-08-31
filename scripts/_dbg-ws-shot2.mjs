/** 一次性:workshop 工作台主页 + 频道视图截图 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-3b8495cf61b34bd4b3c0e02fc242fc66'
const routes = [
  ['workshop', '/workshop', 9000],
  ['channel', '/workshop?channel=c-demo', 9000],
]
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
for (const [name, path, wait] of routes) {
  await page.goto(`http://127.0.0.1:3000${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await new Promise(r => setTimeout(r, wait))
  await page.screenshot({ path: `docs/audit/screenshots/huashu-survey2/${name}.png` })
  console.log('shot:', name, page.url())
}
await browser.close()
