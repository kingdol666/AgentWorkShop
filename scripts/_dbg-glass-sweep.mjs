/** 一次性:Aurora Glass 全页面扫描(暗色为主,抽查亮色) */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROUTES = ['/workshop/agents']
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(`${page.url().replace('http://127.0.0.1:3000', '')}: ${String(e).slice(0, 120)}`))

for (const r of ROUTES) {
  await page.goto(`http://127.0.0.1:3000${r}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {})
  await new Promise(r2 => setTimeout(r2, 12000))
  const slug = r.replace(/\//g, '-').replace(/^-/, '') || 'root'
  await page.screenshot({ path: `docs/audit/screenshots/glass-dark${slug}.png` })
  console.log(`shot ${r}`)
}
console.log('pageerrors:', errors.length ? errors : 'none')
await browser.close()
