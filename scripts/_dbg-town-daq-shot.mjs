/** 一次性:数字孪生页截图(验证 server 驱动的数采节点 3D 渲染 + 值卡) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
await page0(login.data.token)

async function page0(token) {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 18000))
  await page.screenshot({ path: 'docs/audit/screenshots/daq-town-live.png' })
  console.log('town shot ok')
  await browser.close()
}
