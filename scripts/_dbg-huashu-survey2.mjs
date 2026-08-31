/** 一次性:huashu-design 二轮评审勘察 —— 9 路由暗色截图 + console/pageerror 收集 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-3b8495cf61b34bd4b3c0e02fc242fc66'
const routes = [
  ['dash', '/', 12000],
  ['daq', '/daq', 7000],
  ['dcw', '/dcw', 7000],
  ['monitor', '/monitor', 7000],
  ['tokens', '/tokens', 6000],
  ['users', '/users', 6000],
  ['settings', '/settings', 6000],
  ['agents', '/workshop/agents', 7000],
  ['town', '/town', 28000],
]
const outDir = 'docs/audit/screenshots/huashu-survey2'
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
  await page.screenshot({ path: `${outDir}/${name}.png` })
  console.log('shot:', name)
}
await browser.close()
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors')
