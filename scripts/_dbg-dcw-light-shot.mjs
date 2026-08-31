/** 一次性:浅色模式 dcw 页复现截图 */
import puppeteer from 'puppeteer-core'
const TOKEN = 'ut-3b8495cf61b34bd4b3c0e02fc242fc66'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: null }))
})
await page.goto('http://127.0.0.1:3000/dcw', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 8000))
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/light-dcw-before.png' })
console.log('shot light dcw')
await browser.close()
