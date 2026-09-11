/**
 * 评审问题修复验收 —— 逐条复测 UI 评审报告里的实测项。
 * 每条断言都对应报告里的一个具体发现,用同一套判据复测(不是"看起来好了")。
 *
 * 用法:node scripts/_audit/review-fix-verify.mjs [base]
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const OUT = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'D:\\codes\\ABO\\AgentWorkShop\\.e2e-shots\\design-review'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fails.push(name); console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: EXEC, headless: 'new', args: ['--no-sandbox', '--hide-scrollbars'], defaultViewport: { width: 1680, height: 1050 } })
  const lg = await fetch(`${BASE}/api/users/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
  }).then(r => r.json()).catch(() => null)
  const token = lg?.data?.token ?? ''

  for (const theme of ['light', 'dark']) {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    const seed = t => page.evaluate((th, tok) => {
      document.cookie = `token=${encodeURIComponent(tok)}; path=/`
      document.cookie = `aw-theme=${th}; path=/`
      localStorage.setItem('app', JSON.stringify({ isDark: th === 'dark', sidebarCollapsed: false, accent: '', themeTouched: true }))
    }, t, token)

    console.log(`\n=== ${theme} ===`)
    await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded' })
    await seed(theme)
    await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle2' })
    await sleep(900)

    // ① 焦点环不再破坏形状语言(pill 聚焦后仍是药丸)
    const pill = await page.evaluate(() => {
      const el = document.querySelector('.aw-pill') || document.querySelector('.line-pill')
      if (!el) return null
      el.focus()
      const cs = getComputedStyle(el)
      return { radius: cs.borderRadius, outline: cs.outlineColor, offset: cs.outlineOffset }
    })
    ok('聚焦药丸不被压成方角(border-radius 保持)', pill != null && !/^1px/.test(pill.radius), `radius=${pill?.radius}`)
    ok('焦点环用独立配色(--focus-ring,非墨色)', pill != null && !/41,\s*37,\s*36/.test(pill.outline), `outline=${pill?.outline}`)

    // ② 模态盖得住侧栏 + Esc 可关
    const modalBtn = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .aw-pill, .line-pill')]
      const b = btns.find(x => /添加|新建|add/i.test(x.textContent ?? ''))
      if (b) { b.click(); return b.textContent.trim().slice(0, 20) }
      return null
    })
    if (modalBtn) {
      await sleep(500)
      const covered = await page.evaluate(() => {
        const mask = document.querySelector('.modal-mask')
        if (!mask) return { open: false }
        // 侧栏区域取样点:遮罩是否真的盖在上面
        const el = document.elementFromPoint(120, 500)
        return { open: true, topEl: el?.className?.toString?.() ?? el?.tagName ?? '' }
      })
      ok('模态已打开', covered.open, modalBtn)
      if (covered.open) {
        ok('遮罩盖住侧栏(elementFromPoint 命中遮罩而非侧栏菜单)',
          !/menu-item|ant-menu/.test(covered.topEl), `top=${covered.topEl}`)
        await page.keyboard.press('Escape')
        await sleep(500)
        const stillOpen = await page.evaluate(() => Boolean(document.querySelector('.modal-mask')))
        ok('Esc 可关闭模态', !stillOpen)
      }
    }
    else {
      ok('模态按钮可定位', false, '未找到"添加/新建"按钮')
    }

    // ③ 趋势空态:无采样时给明确文案,而不是空图
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' })
    await sleep(1200)
    const trend = await page.evaluate(() => {
      const chart = document.querySelector('.chart.h280 canvas')
      const empty = document.querySelector('.aw-empty.h280')
      return { hasCanvas: Boolean(chart), hasEmpty: Boolean(empty), emptyText: (empty?.textContent ?? '').trim().slice(0, 60) }
    })
    ok('趋势区要么有图要么有空态(不留裸空图)', trend.hasCanvas || trend.hasEmpty,
      `canvas=${trend.hasCanvas} empty=${trend.hasEmpty}`)
    if (trend.hasEmpty) ok('空态文案说明采样门控原因', /开跑|批次/.test(trend.emptyText), trend.emptyText)

    // ④ /aml 非冷启动进入不丢主题、不掉到折叠线以下
    await page.goto(`${BASE}/dcw`, { waitUntil: 'networkidle2' })
    await sleep(400)
    await page.goto(`${BASE}/aml`, { waitUntil: 'networkidle2' })
    // 轮询等待布局收敛:同时区分"永久错位"与"水合期瞬时位移"(CLS)
    let settledMs = -1
    const t0 = Date.now()
    let last = null
    while (Date.now() - t0 < 4000) {
      last = await page.evaluate(() => {
        const main = document.querySelector('.app-main')
        const layout = document.querySelector('.app-layout')
        const sider = document.querySelector('.app-sider')
        return {
          isDark: document.documentElement.classList.contains('dark'),
          hasSider: Boolean(document.querySelector('.ant-layout-has-sider')),
          layoutDir: layout ? getComputedStyle(layout).flexDirection : '',
          mainTop: Math.round(main?.getBoundingClientRect().top ?? -1),
          siderTop: Math.round(sider?.getBoundingClientRect().top ?? -1),
          siderLeft: Math.round(sider?.getBoundingClientRect().left ?? -1),
          contentTop: Math.round(document.querySelector('.app-content')?.getBoundingClientRect().top ?? -1),
          docH: document.documentElement.scrollHeight,
          viewport: window.innerHeight,
        }
      })
      // 判据只要求"内容起点在视口内"(即没被推到折叠线以下)。
      // 刻意**不**约束 docH:有内容的页面本来就该可以滚动(docH 1255 > vh 1050 是正常的),
      // 早先顺手加上 docH<=vh+60 把正常页面也判成失败 —— 断言写过头同样是 bug。
      if (last.contentTop >= 0 && last.contentTop < last.viewport && last.mainTop < last.viewport) {
        settledMs = Date.now() - t0
        break
      }
      await sleep(120)
    }
    const aml = last
    ok('/aml 二次进入仍保持暗色主题', theme === 'light' ? !aml.isDark : aml.isDark,
      `html.dark=${aml.isDark} (期望 ${theme === 'dark'})`)
    ok('/aml 保留 ant-layout-has-sider(横向布局)', aml.hasSider)
    ok('/aml 内容未掉到折叠线以下(或已收敛)', settledMs >= 0,
      `收敛=${settledMs}ms contentTop=${aml.contentTop} docH=${aml.docH} vh=${aml.viewport} `
      + `layoutDir=${aml.layoutDir} mainTop=${aml.mainTop} siderTop=${aml.siderTop} siderLeft=${aml.siderLeft}`)

    // 截图存档
    await page.screenshot({ path: join(OUT, `fix-verify-${theme}-aml.png`) })
    await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle2' })
    await sleep(900)
    await page.screenshot({ path: join(OUT, `fix-verify-${theme}-daq.png`) })
    await ctx.close()
  }

  await browser.close()
  console.log(`\n结果:${pass} 通过 / ${fails.length} 失败`)
  if (fails.length) console.log(fails.join('\n'))
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
