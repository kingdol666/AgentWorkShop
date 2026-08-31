/** 一次性:huashu-design 美化前勘察 —— 6 路由暗色截图 + console/pageerror 收集 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const routes = [
  ['dash', '/', 9000],
  ['daq', '/daq', 6000],
  ['dcw', '/dcw', 6000],
  ['town', '/town', 26000],
  ['agents', '/workshop/agents', 6000],
  ['tokens', '/tokens', 6000],
]
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(`[pageerror] ${String(e).slice(0, 160)}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 160)}`) })
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
for (const [name, path, wait] of routes) {
  await page.goto(`http://127.0.0.1:3000${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await new Promise(r => setTimeout(r, wait))
  await page.screenshot({ path: `docs/audit/screenshots/huashu-survey-${name}.png` })
  console.log('shot:', name)
}
await browser.close()
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors')
