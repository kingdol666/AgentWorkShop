// 验收阶段5b:workspace 会话页 + 数字孪生(挂载后)
import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:3021'
const WS = process.argv[2] ?? 'c99321bd-3352-4362-88e2-4141dcdd9331'
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/workshop/w/${WS}`, { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: '.e2e-shots/acc-5-workshop-channel.png' })
console.log('📷 workshop-channel')
await page.goto(`${BASE}/town`, { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 10000))
await page.screenshot({ path: '.e2e-shots/acc-5-town-2.png' })
console.log('📷 town-2')
await browser.close()
