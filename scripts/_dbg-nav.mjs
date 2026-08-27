import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 6000))
const d = await page.evaluate(() => {
  const nav = document.querySelector('.nav-tabs')
  if (!nav) return { err: 'no nav' }
  return [...nav.children].map((el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      tag: el.tagName, cls: el.className.toString().slice(0, 40), text: el.textContent.trim().slice(0, 12),
      w: Math.round(r.width), bg: cs.backgroundColor, color: cs.color,
    }
  })
})
console.log(JSON.stringify(d, null, 1))
await browser.close()
