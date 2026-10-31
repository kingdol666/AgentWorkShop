// 实机演示截图驱动:登录态 cookie + vpTier 等待 + 全页截图
// 用法: node demo-shots.mjs <outDir> <path:outName> [path:outName ...]
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3300'
const TOKEN = process.env.DEMO_TOKEN
const outDir = process.argv[2]
const targets = process.argv.slice(3)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  protocolTimeout: 900_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.setCookie({ name: 'aw-theme', value: 'dark', domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument((isDark) => {
  try { localStorage.setItem('app', JSON.stringify({ isDark, sidebarCollapsed: false, accent: null, themeTouched: true })) } catch { /* 帧间隙 */ }
}, true)

for (const t of targets) {
  const [path, name] = t.split('::')
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 60_000, polling: 200 })
    await sleep(3500)
    await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false })
    console.log(`✔ ${path} → ${name}.png`)
  } catch (e) {
    console.log(`✖ ${path}: ${String(e).slice(0, 120)}`)
  }
}
await browser.close()
process.exit(0)
