/**
 * 玻璃材质验收 —— 用计算样式 + 像素统计双重取证,判定"毛玻璃是否真的在渲染"。
 *
 * 为什么必须实测:变量驱动的 backdrop-filter 曾在产物里只剩 `-webkit-` 前缀版,
 * 而该前缀在 Chromium 已不受支持 → 计算值恒为 none、侧栏退化成纯色板,
 * 单看源码完全看不出来(源码里两个属性都写着)。所以这里:
 *   ① 读 getComputedStyle().backdropFilter(证明属性生效)
 *   ② 统计侧栏/顶栏空白区的颜色簇数与 RGB 跨度(证明背后极光真的透出来)
 *
 * 用法:node scripts/_audit/glass-verify.mjs [base] [--out=dir]
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const BASE = (process.argv[2] ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const OUT = (process.argv.find(a => a.startsWith('--out='))?.slice(6)) ?? join(REPO, '.e2e-shots', 'design')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: EXEC, headless: 'new', args: ['--no-sandbox', '--hide-scrollbars'], defaultViewport: { width: 1680, height: 1050 } })
  const page = await browser.newPage()

  // 种鉴权 + 主题(与产品同一持久化键)
  const lg = await fetch(`${BASE}/api/users/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
  }).then(r => r.json()).catch(() => null)
  const token = lg?.data?.token ?? ''

  let bad = 0
  const say = (name, ok, detail = '') => {
    console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) bad++
  }

  for (const theme of ['light', 'dark']) {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.evaluate((t, tok) => {
      document.cookie = `token=${encodeURIComponent(tok)}; path=/`
      document.cookie = `aw-theme=${t}; path=/`
      localStorage.setItem('app', JSON.stringify({ isDark: t === 'dark', sidebarCollapsed: false, accent: '', themeTouched: true }))
    }, theme, token)
    await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle2' })
    await sleep(1400)

    console.log(`\n=== ${theme} ===`)

    // ① 计算样式:玻璃层是否真的带 blur
    const computed = await page.evaluate(() => {
      const grab = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const cs = getComputedStyle(el)
        return { sel, backdropFilter: cs.backdropFilter, webkit: cs.webkitBackdropFilter, bg: cs.backgroundColor }
      }
      return {
        sider: grab('.app-sider'),
        header: grab('.app-header-glass'),
        footer: grab('.app-footer'),
        bench: grab('.aw-bench'),
        supportsStd: CSS.supports('backdrop-filter', 'blur(10px)'),
        supportsWebkit: CSS.supports('-webkit-backdrop-filter', 'blur(10px)'),
      }
    })
    const blurOf = v => (v && v !== 'none' ? v : '')
    say('浏览器支持标准 backdrop-filter', computed.supportsStd === true)
    say('浏览器**不支持** -webkit- 前缀(故产物不能只留前缀版)', computed.supportsWebkit === false,
      `supports('-webkit-backdrop-filter')=${computed.supportsWebkit}`)
    say('.app-sider 毛玻璃生效', blurOf(computed.sider?.backdropFilter).includes('blur'),
      computed.sider?.backdropFilter)
    say('.app-header-glass 毛玻璃生效', blurOf(computed.header?.backdropFilter).includes('blur'),
      computed.header?.backdropFilter)
    say('.app-footer 毛玻璃生效', blurOf(computed.footer?.backdropFilter).includes('blur'),
      computed.footer?.backdropFilter)
    // 面板刻意不付 backdrop 成本(靠半透底+折射边),这里断言它确实没有(性能纪律)
    say('.aw-bench 刻意不使用 backdrop-filter(性能取舍)', blurOf(computed.bench?.backdropFilter) === '',
      computed.bench?.backdropFilter)

    // ② 像素取证(因果判定):在**同一位置**分别采样"有玻璃"与"临时关掉 backdrop-filter"的渲染,
    //    两者像素必须不同 —— 这直接证明玻璃在起视觉作用,且不受"该处背景恰好是纯色"的干扰
    //    (只用"颜色簇数"判定会被极光几何坑到:极光没覆盖到的角落,正常玻璃也是纯色)。
    const causal = await (async () => {
      const geo = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }, '.app-sider')
      if (!geo) return null
      // 侧栏中段:靠近极光中心区,且避开菜单文字(取上半段空白)
      const clip = { x: geo.x + 3, y: geo.y + 70, width: Math.max(10, geo.w - 6), height: 60 }
      const sample = async () => {
        const b64 = await page.screenshot({ clip, encoding: 'base64' })
        return await page.evaluate(async (data) => {
          const img = new Image()
          img.src = `data:image/png;base64,${data}`
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d')
          ctx.drawImage(img, 0, 0)
          const px = ctx.getImageData(0, 0, c.width, c.height).data
          const clusters = new Set()
          let span = 0
          for (let i = 0; i < px.length; i += 4) {
            clusters.add(`${px[i] >> 3}-${px[i + 1] >> 3}-${px[i + 2] >> 3}`)
            span += px[i] + px[i + 1] + px[i + 2]
          }
          return { clusters: clusters.size, sum: span, n: px.length / 4, w: c.width, h: c.height }
        }, b64)
      }
      const withGlass = await sample()
      // 关掉玻璃(仅本元素,立刻还原)
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        el.dataset.awGlassBak = el.style.backdropFilter || ''
        el.style.backdropFilter = 'none'
      }, '.app-sider')
      await sleep(220)
      const noGlass = await sample()
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        el.style.backdropFilter = el.dataset.awGlassBak || ''
      }, '.app-sider')
      const meanA = withGlass.sum / withGlass.n
      const meanB = noGlass.sum / noGlass.n
      return { withGlass, noGlass, delta: Math.abs(meanA - meanB) }
    })()
    if (causal) {
      // 判据:两者平均亮度必须可辨地不同(>0.5/765 ≈ 肉眼可分辨),即玻璃确实改变了像素
      say('玻璃对渲染有实际影响(开/关玻璃像素不同)', causal.delta > 0.5,
        `Δ亮度均值=${causal.delta.toFixed(2)} 有玻璃簇=${causal.withGlass.clusters} 无玻璃簇=${causal.noGlass.clusters}`)
      await page.screenshot({ path: join(OUT, `glass-${theme}.png`) })
    }
    else {
      say('侧栏可取证', false)
    }
  }

  await browser.close()
  console.log(`\n${bad === 0 ? '玻璃材质验收通过' : `${bad} 项未通过`}`)
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
