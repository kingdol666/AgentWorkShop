// 非 headless 实机窗口截图（Channel / Project）——报表 §五 desktop-*.png 的生成器
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:4001'
const OUT = 'docs/audit/evidence/2026-11-08-full-acceptance/ui'
mkdirSync(OUT, { recursive: true })
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
})
const token = (await login.json()).data.token
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  args: ['--no-sandbox', '--window-size=1600,1000', '--window-position=40,40'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
const shots = [
  ['/workshop/w/90466b5c-043f-499e-b815-2072ab22d8db?channel=0d80ae9f-2796-4429-afba-9b0614911966', 'desktop-channel.png'],
  ['/projects/be5fbcb1-a988-4bbb-aac5-c28387f3a77a', 'desktop-project.png'],
]
for (const [path, name] of shots) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await new Promise(r => setTimeout(r, 6500))
  await page.screenshot({ path: `${OUT}/${name}` })
  console.log('shot', name)
}
await browser.close()
