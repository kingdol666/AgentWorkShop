// 设计战役:当前前端基线截图(before)。真实 Chrome + 会话 cookie。
// 用法: node scripts/_audit/_design-capture.mjs <outDir> <name::path> ...
import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:4001'
const OUT = process.argv[2]
const TARGETS = process.argv.slice(3)
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.AW_UI_EMAIL ?? 'deep-admin@aw.local',
    password: process.env.AW_UI_PASSWORD ?? 'Deep#2026-test',
  }),
})
const payload = await login.json()
const token = payload?.data?.token
if (!token) throw new Error(`login failed status=${login.status}`)

const W = Number(process.env.AW_W ?? 1600)
const H = Number(process.env.AW_H ?? 1000)
const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  protocolTimeout: 900_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},${H}`],
})
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: null, themeTouched: true })) } catch { /* frame gap */ }
})

let index = 0
for (const t of TARGETS) {
  const [name, path] = t.split('::')
  const errors = []
  page.removeAllListeners('pageerror')
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 60_000, polling: 200 })
    await sleep(4500)
    // 聊天式页面等首帧消息渲染(WS 订阅)
    if (/\/workshop\/w\/|\/projects\//.test(path)) await sleep(2500)
    index += 1
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
    const info = await page.evaluate(() => ({
      len: document.body?.innerText?.length ?? 0,
      lead: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 90),
    }))
    console.log(`✔ ${name} len=${info.len} err=${errors.length} ${info.lead}`)
  } catch (e) {
    console.log(`✖ ${name}: ${String(e).slice(0, 160)}`)
  }
}
await browser.close()
