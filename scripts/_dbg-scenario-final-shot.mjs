/** 最终场景截图:控制台 SET=183(Agent 优化后)+ 全景实时 */
import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const OUT = 'docs/audit/screenshots/ui-polish-0831'
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 45; i++) { if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break; await new Promise(r => setTimeout(r, 1000)) }
await new Promise(r => setTimeout(r, 4000))
const twins = await fetch(`${BASE}/api/workshop/device-twins`, { headers: { authorization: `Bearer ${login.data.token}` } }).then(r => r.json())
const consoleId = (twins.data.twins ?? []).find(t => t.name === '控制台 · CON')?.id
await page.evaluate((id) => { window.__town.scene.setSelected?.({ kind: 'device', id }) }, consoleId)
await new Promise(r => setTimeout(r, 1500))
const rows = await page.evaluate(() => ({
  dcw: [...document.querySelectorAll('.twin-dcw .dcw-item')].map(el => el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 50)),
  daq: [...document.querySelectorAll('.twin-daq .daq-item')].map(el => el.textContent?.replace(/\s+/g, ' ').trim()),
}))
console.log('控制台 SET rows:', JSON.stringify(rows.dcw))
await page.screenshot({ path: `${OUT}/e2e-final-console-183.png` })
await browser.close()
console.log('final shot done')
