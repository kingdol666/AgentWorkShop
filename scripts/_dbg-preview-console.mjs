/** 一次性:preview 控制台报错捕获(WebGL/着色器错误) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', e => errors.push(`[pageerror] ${String(e).slice(0, 300)}`))
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 12000))
const uniq = [...new Set(errors)]
console.log(uniq.length ? uniq.join('\n') : '(no console errors)')
await browser.close()
