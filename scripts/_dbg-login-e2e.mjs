import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:3001'
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })

// 登出态访问 /workshop → 登录门 → 用「用户名 admin」走账号登录页签
await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 2000))
await page.screenshot({ path: '.e2e-shots/login-1-gate.png' })
const ph = await page.evaluate(() => [...document.querySelectorAll('input')].map(i => i.placeholder).filter(Boolean).join(' | '))
console.log('placeholders:', ph)

// 用户名登录
const inputs = await page.$$('.auth-card input')
const emailInput = await page.$('.auth-card input[type="email"]') ?? (await page.$$('.auth-card input'))[0]
await emailInput.click({ clickCount: 3 })
await emailInput.type('admin')
const pw = await page.$('.auth-card input[type="password"]')
await pw.click({ clickCount: 3 })
await pw.type('admin123')
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.body.innerText.includes('Workshop'), { timeout: 30000 })
console.log('✔ 用户名 admin 登录成功,已进入项目')
await page.screenshot({ path: '.e2e-shots/login-2-username-ok.png' })
await browser.close()
