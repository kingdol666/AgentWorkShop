/**
 * /aml 布局错位定点定位 —— 复刻 review-fix-verify 的完整上下文
 * (新建 browser context + 模态交互 + 多跳导航),然后打印祖先链与几何。
 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3111'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME
const sleep = ms => new Promise(r => setTimeout(r, ms))

const chainOf = `(el) => { const out = []; let e = el; while (e && e.tagName !== 'BODY') {
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
  out.push({ t: e.tagName + '.' + e.className.toString().split(' ').filter(c => !c.startsWith('css-')).slice(0, 3).join('.'),
    top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
    disp: cs.display, dir: cs.flexDirection, pos: cs.position })
  e = e.parentElement } return out }`

async function main() {
  const browser = await puppeteer.launch({ executablePath: EXEC, headless: 'new', args: ['--no-sandbox', '--hide-scrollbars'], defaultViewport: { width: 1680, height: 1050 } })
  const lg = await fetch(`${BASE}/api/users/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
  }).then(r => r.json())
  const token = lg.data.token

  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => {
    document.cookie = `token=${encodeURIComponent(t)}; path=/`
    document.cookie = 'aw-theme=light; path=/'
    // 与 review-fix-verify 一致的 pinia 持久化预置(唯一未复刻的变量)
    localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: '', themeTouched: true }))
  }, token)
  await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle2' })
  await sleep(900)
  // 模态交互
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, .aw-pill, .line-pill')]
    const b = btns.find(x => /添加|新建|add/i.test(x.textContent ?? ''))
    b?.click()
  })
  await sleep(500)
  await page.keyboard.press('Escape')
  await sleep(500)
  // 多跳
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' })
  await sleep(1200)
  await page.goto(`${BASE}/dcw`, { waitUntil: 'networkidle2' })
  await sleep(400)
  await page.goto(`${BASE}/aml`, { waitUntil: 'networkidle2' })
  await sleep(2000)

  const dump = await page.evaluate(`(() => {
    const chainOf = ${chainOf}
    const main = document.querySelector('.app-main')
    const sider = document.querySelector('.app-sider')
    const layouts = [...document.querySelectorAll('.ant-layout')].map(e => {
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      return { cls: e.className.toString().slice(0, 50), top: Math.round(r.top), left: Math.round(r.left),
        w: Math.round(r.width), h: Math.round(r.height), dir: cs.flexDirection, wrap: cs.flexWrap }
    })
    return {
      docH: document.documentElement.scrollHeight,
      layouts,
      mainChain: chainOf(main),
      siderChain: chainOf(sider),
      sider: (() => { const r = sider?.getBoundingClientRect(); const cs = sider ? getComputedStyle(sider) : null
        return sider ? { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display, position: cs.position, flex: cs.flex, cssFloat: cs.cssFloat } : null })(),
      layoutDisplay: (() => { const L = document.querySelector('.app-layout'); const cs = getComputedStyle(L)
        return { display: cs.display, dir: cs.flexDirection, wrap: cs.flexWrap, w: Math.round(L.getBoundingClientRect().width) } })(),
      mainParentHTMLHead: main?.parentElement?.outerHTML.slice(0, 260),
    }
  })()`)
  console.log(JSON.stringify(dump, null, 1))
  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
