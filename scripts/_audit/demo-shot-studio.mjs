// EDA 工坊交互截图:进入 /studio → 点击"我的图表"中指定标题的图 → 等渲染 → 截图
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3300'
const TOKEN = process.env.DEMO_TOKEN
const OUT = process.argv[2]
const TITLE = process.argv[3] ?? 'DEMO2'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true, protocolTimeout: 900_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.setCookie({ name: 'aw-theme', value: 'dark', domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('app', JSON.stringify({ isDark: true, sidebarCollapsed: false, accent: null, themeTouched: true })) } catch { /* 帧间隙 */ }
})
await page.goto(BASE + '/studio', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 60_000, polling: 200 })
await sleep(2500)
const clicked = await page.evaluate((title) => {
  const els = [...document.querySelectorAll('button, [role=button], .cursor-pointer, li, div')]
    .filter(el => (el.textContent ?? '').includes(title) && (el.textContent ?? '').length < 60)
  const el = els[els.length - 1]
  if (el) { el.click(); return (el.textContent ?? '').trim().slice(0, 40) }
  return null
}, TITLE)
console.log('clicked:', clicked)
await sleep(6000)
await page.screenshot({ path: OUT, fullPage: false })
console.log('shot →', OUT)
await browser.close()
process.exit(0)
