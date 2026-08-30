/** 一次性:仪表盘大屏 + 品牌(logo/标题/favicon/侧栏)验证截图 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=2560,1400'],
})
const page = await browser.newPage()
await page.setViewport({ width: 2560, height: 1400 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 120)))
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 8000))

const checks = await page.evaluate(() => ({
  title: document.title,
  favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href'),
  logoSvg: !!document.querySelector('.logo-mark svg'),
  logoSub: document.querySelector('.logo-sub')?.textContent?.trim(),
  harnessGone: !document.body.textContent?.toLowerCase().includes('agent harness'),
  kpis: [...document.querySelectorAll('.kpi')].map(k => `${k.querySelector('.kpi-label')?.textContent}:${k.querySelector('.kpi-value')?.textContent}`),
  panels: [...document.querySelectorAll('.dp-hd h3')].map(h => h.textContent?.trim()),
  canvases: document.querySelectorAll('.dpanel canvas').length,
  lineCards: document.querySelectorAll('.line-card').length,
  heroTitle: document.querySelector('.hero-title')?.textContent?.replace(/\s+/g, ' ').trim(),
}))
console.log(JSON.stringify(checks, null, 1))
await page.screenshot({ path: 'docs/audit/screenshots/dashboard-bigscreen.png' })
await new Promise(r => setTimeout(r, 7000))
await page.screenshot({ path: 'docs/audit/screenshots/dashboard-bigscreen-t7.png' })
console.log('page errors:', errors.length ? errors : 'none')
await browser.close()
