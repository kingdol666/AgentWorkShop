/** 交互验证:/town 趋势「+N」展开 → 收起。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(20000)

const chipCount = () => page.evaluate(() => document.querySelectorAll('.trend-legend .lg-chip:not(.lg-more)').length)
const moreText = () => page.evaluate(() => document.querySelector('.lg-more')?.textContent.trim())

console.log('collapsed chips:', await chipCount(), '| more btn:', await moreText())
await page.click('.lg-more')
await sleep(600)
console.log('expanded chips:', await chipCount(), '| more btn:', await moreText())
const dock = await page.$('.dock')
await dock.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-dock-expanded.png' })
await page.click('.lg-more')
await sleep(600)
console.log('collapsed again chips:', await chipCount(), '| more btn:', await moreText())
await dock.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-dock-collapsed.png' })
await browser.close()
console.log('DONE')
