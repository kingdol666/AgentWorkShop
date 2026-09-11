/**
 * 冷启动水合自检 —— 判断 "Hydration completed but contains mismatches" 是否产品自身问题。
 * 三种上下文各开一个干净 profile:
 *   A. 全新访客(无 cookie / 无 localStorage)
 *   B. 仅主题 cookie(aw-theme=light / dark)
 *   C. 主题 cookie + pinia 持久化 localStorage
 * 若 A 也报 → 产品自身问题;仅 B/C 报 → 持久化水合问题。
 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME
const PAGES = ['/', '/daq', '/dcw', '/settings']
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CASES = [
  ['A 全新访客', { theme: null, persisted: false }],
  ['B 仅主题 cookie', { theme: 'light', persisted: false }],
  ['C cookie + localStorage', { theme: 'light', persisted: true }],
]

async function main() {
  const browser = await puppeteer.launch({ executablePath: EXEC, headless: 'new', args: ['--no-sandbox', '--hide-scrollbars'], defaultViewport: { width: 1400, height: 900 } })
  for (const [label, cfg] of CASES) {
    const ctx = await browser.createBrowserContext() // 干净 storage
    const page = await ctx.newPage()
    const msgs = []
    page.on('console', (m) => {
      if (m.type() === 'error') msgs.push(m.text())
    })
    // 先访问一次以便写 cookie/storage,再 reload 观察水合
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.evaluate((c) => {
      if (c.theme) document.cookie = `aw-theme=${c.theme}; path=/`
      if (c.persisted) {
        localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: '', themeTouched: true }))
      }
      else {
        localStorage.clear()
      }
    }, cfg)
    msgs.length = 0
    const hits = []
    for (const p of PAGES) {
      await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' })
      await sleep(900)
      const bad = msgs.filter(m => /[Hh]ydration/.test(m))
      hits.push(`${p}:${bad.length}`)
    }
    console.log(`  ${label.padEnd(24)} 水合告警 ${hits.join('  ')}`)
    await ctx.close()
  }
  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
