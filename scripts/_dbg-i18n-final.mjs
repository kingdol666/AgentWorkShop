/** 一次性:zh 回归 + en 截图。zh 清除 aw.locale(默认中文);en 设置 aw.locale=en。 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))

// zh 回归
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 90000 })
await page.evaluate(() => localStorage.removeItem('aw.locale'))
const zhProbe = {}
for (const r of ['/', '/daq', '/dcw']) {
  await page.goto(`http://127.0.0.1:3000${r}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {})
  await new Promise(r2 => setTimeout(r2, 2500))
  zhProbe[r] = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    hasZh: /[\u4e00-\u9fff]/.test(document.body.innerText),
    menuFirst: document.querySelector('.menu-item')?.textContent?.trim() ?? '',
  }))
}
console.log('zh regression:', JSON.stringify(zhProbe))
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'networkidle2' })
await new Promise(r => setTimeout(r, 1500))
await page.screenshot({ path: 'docs/audit/screenshots/i18n-zh-daq.png' })

// en 截图
await page.evaluate(() => localStorage.removeItem('aw.locale'))
for (const r of ['/town', '/daq']) {
  await page.goto(`http://127.0.0.1:3000${r}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {})
  await new Promise(r2 => setTimeout(r2, r === '/town' ? 12000 : 2000))
  await page.screenshot({ path: `docs/audit/screenshots/i18n-en${r.replace(/\//g, '-').replace(/^-$/, '-root')}.png` })
}
console.log('page errors:', errors.length ? errors.slice(0, 4) : 'none')
await browser.close()
