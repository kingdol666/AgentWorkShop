/** 一次性:仪表盘 —— elementFromPoint + reduced-motion 截图 */
import puppeteer from 'puppeteer-core'

const loginRes = await fetch('http://127.0.0.1:3000/api/users/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = loginRes?.data?.token

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000', '--force-prefers-reduced-motion'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))

const info = await page.evaluate(() => {
  const home = document.querySelector('.home')
  const r = home?.getBoundingClientRect()
  const pts = [[800, 300], [400, 200], [800, 700], [300, 120]]
  const hits = pts.map(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return `${x},${y}: null`
    const cs = getComputedStyle(el)
    return `${x},${y}: ${el.tagName}.${String(el.className).slice(0, 50)} op=${cs.opacity} color=${cs.color} bg=${cs.backgroundColor}`
  })
  const dark = document.documentElement.classList.contains('dark')
  const head = document.querySelector('.app-header')
  return {
    dark,
    homeRect: r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : 'none',
    headerPresent: !!head,
    canvases: document.querySelectorAll('canvas').length,
    hits,
  }
})
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: 'docs/audit/screenshots/ui-polish-0831/dash-reduced-motion.png' })
await browser.close()
