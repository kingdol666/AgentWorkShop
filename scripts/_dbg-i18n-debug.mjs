/** 一次性:调试 en 恢复逻辑(AppHeader onMounted setLocale) */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setCookie({ name: 'token', value: 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 60000 })
await page.evaluate(() => localStorage.setItem('aw.locale', 'en'))
await page.reload({ waitUntil: 'networkidle2' })
await new Promise(r => setTimeout(r, 4000))
const dbg = await page.evaluate(() => {
  const links = [...document.querySelectorAll('.menu-item, [class*="menu"]')]
  return {
    stored: localStorage.getItem('aw.locale'),
    htmlLang: document.documentElement.getAttribute('lang'),
    dashboardTexts: [...document.querySelectorAll('span,button,a,p')]
      .map(e => e.textContent?.trim())
      .filter(t => t === '仪表盘' || t === 'Dashboard')
      .slice(0, 3),
  }
})
console.log(JSON.stringify(dbg))
await browser.close()
