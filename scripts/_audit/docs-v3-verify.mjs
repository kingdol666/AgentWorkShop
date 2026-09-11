/**
 * docs-v3-verify.mjs —— 逐条复验视觉评审提出的缺陷是否真的修好了
 * 每条断言都取自评审给出的**可测判据**,不做肉眼判断。
 * 用法:node scripts/_audit/docs-v3-verify.mjs
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const DIST = join(REPO, 'docs', 'site', '.vitepress', 'dist')
const BASE_PATH = '/AgentWorkShop'
const PORT = 3225
const OUT = join(REPO, '.e2e-shots', 'v3-verify')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.gif': 'image/gif', '.map': 'application/json' }

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`)
    return
  }
  fail++
  console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`)
}

function serve() {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (!p.startsWith(BASE_PATH)) {
        res.writeHead(404)
        res.end()
        return
      }
      p = p.slice(BASE_PATH.length) || '/'
      let f = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, ''))
      if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html')
      if (!existsSync(f) && !extname(f)) f = `${f}.html`
      if (!existsSync(f)) {
        res.writeHead(404)
        res.end('nf')
        return
      }
      res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' })
      res.end(readFileSync(f))
    })
    s.listen(PORT, '127.0.0.1', () => ok(s))
  })
}

const relLum = ([r, g, b]) => {
  const f = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const parseRgb = s => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number)
const contrast = (a, b) => {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

mkdirSync(OUT, { recursive: true })
const server = await serve()
const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900 },
})
const base = `http://127.0.0.1:${PORT}${BASE_PATH}`
const open = async (route) => {
  const page = await browser.newPage()
  await page.goto(`${base}${route}`, { waitUntil: 'networkidle2' })
  await page.evaluate(() => document.fonts?.ready).catch(() => {})
  await new Promise(r => setTimeout(r, 700))
  return page
}

try {
  console.log('\n━━━ B1 代码高亮必须是暗色主题(每个 token ≥4.5:1)━━━')
  {
    const page = await open('/guide/getting-started')
    const r = await page.evaluate(() => {
      const pre = document.querySelector('.vp-doc div[class*="language-"]')
      const bg = getComputedStyle(pre).backgroundColor
      const seen = new Map()
      for (const el of pre.querySelectorAll('span[style*="color"], span[class*="shiki"]')) {
        const c = getComputedStyle(el).color
        const txt = (el.textContent ?? '').trim()
        if (!txt) continue
        if (!seen.has(c)) seen.set(c, txt.slice(0, 16))
      }
      return { bg, colors: [...seen].map(([c, t]) => ({ c, t })) }
    })
    const bg = parseRgb(r.bg)
    const bad = []
    for (const { c, t } of r.colors) {
      const ratio = contrast(parseRgb(c), bg)
      if (ratio < 4.5) bad.push(`${c} (${ratio.toFixed(2)}:1) "${t}"`)
    }
    check(`代码 token 全部 ≥4.5:1(检查 ${r.colors.length} 色)`, bad.length === 0, bad.join('  '))
    const strings = r.colors.find(x => x.c.replace(/\s/g, '') === 'rgb(3,47,98)')
    check('浅色主题的 #032f62 已消失', !strings)
    await page.close()
  }

  console.log('\n━━━ B2 入场动画必须真正命中元素 ━━━')
  {
    const page = await open('/guide/aml')
    const r = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.vp-doc *')]
      const anim = all.filter(e => getComputedStyle(e).animationName.includes('aw-rise'))
      return { matched: anim.length, firstTag: anim[0]?.tagName ?? null, docChildren: document.querySelector('.vp-doc')?.children.length }
    })
    check('存在带 aw-rise 的元素', r.matched > 0, `matched=${r.matched} first=${r.firstTag} vpDocChildren=${r.docChildren}`)
    await page.close()
  }

  console.log('\n━━━ B3 reduce 模式不得点亮全部侧栏刻度 ━━━')
  {
    const visible = async (reduce) => {
      const page = await browser.newPage()
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }])
      await page.goto(`${base}/guide/aml`, { waitUntil: 'networkidle2' })
      await new Promise(r => setTimeout(r, 500))
      const n = await page.evaluate(() => {
        let c = 0
        for (const el of document.querySelectorAll('.VPSidebarItem.level-1')) {
          const st = getComputedStyle(el.querySelector('.item'), '::before')
          if (st.content && st.content !== 'none' && !/matrix\(\s*0[,)]/.test(st.transform) && st.transform !== 'none') c++
          else if (st.content && st.content !== 'none' && st.transform.startsWith('matrix(1')) c++
        }
        return c
      })
      const total = await page.evaluate(() => document.querySelectorAll('.VPSidebarItem.level-1').length)
      await page.close()
      return { n, total }
    }
    const off = await visible(false)
    const on = await visible(true)
    check('no-preference 下恰好 1 个刻度可见', off.n === 1, `${off.n}/${off.total}`)
    check('reduce 下同样只有 1 个刻度可见(未被反转)', on.n === off.n, `reduce=${on.n} vs normal=${off.n}`)
  }

  console.log('\n━━━ B5 / P1 焦点环不得改变圆角;CTA 不得被画绿线 ━━━')
  {
    const page = await open('/')
    const r = await page.evaluate(() => {
      const btn = document.querySelector('.hw-btn')
      const before = getComputedStyle(btn).borderRadius
      btn.focus()
      const after = getComputedStyle(btn).borderRadius
      const focusVisible = btn.matches(':focus-visible')
      const bgImage = getComputedStyle(document.querySelector('.hw-btn.primary') ?? btn).backgroundImage
      return { before, after, focusVisible, bgImage }
    })
    check('聚焦前后 border-radius 不变', r.before === r.after, `${r.before} → ${r.after}(focus-visible=${r.focusVisible})`)
    check('CTA 上没有下划线渐变(绿色 1px 横线)', !/linear-gradient/.test(r.bgImage), r.bgImage.slice(0, 60))
    await page.close()
  }

  console.log('\n━━━ P2 --aw-ghost 不得用作文字颜色 ━━━')
  {
    const page = await open('/cli/')
    const r = await page.evaluate(() => {
      const lang = document.querySelector('.vp-doc div[class*="language-"] > span.lang')
      const pre = document.querySelector('.vp-doc div[class*="language-"]')
      return lang ? { color: getComputedStyle(lang).color, bg: getComputedStyle(pre).backgroundColor } : null
    })
    if (!r) check('找到语言标签', false)
    else {
      const ratio = contrast(parseRgb(r.color), parseRgb(r.bg))
      check(`语言标签对比度 ≥4.5:1`, ratio >= 4.5, `${r.color} on ${r.bg} = ${ratio.toFixed(2)}:1`)
    }
    await page.close()
  }

  console.log('\n━━━ P4 / P5 无内容可折射的表面不得使用 backdrop-filter ━━━')
  {
    const page = await open('/guide/getting-started')
    const r = await page.evaluate(() => {
      const bd = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).backdropFilter : '(no element)'
      }
      return { sidebar: bd('.VPSidebar'), console: bd('.aw-console') }
    })
    check('桌面侧栏无 backdrop-filter', r.sidebar === 'none', r.sidebar)
    const home = await open('/')
    const c = await home.evaluate(() => {
      const el = document.querySelector('.aw-console')
      return el ? getComputedStyle(el).backdropFilter : '(no element)'
    })
    check('.aw-console 无 backdrop-filter', c === 'none', c)
    await home.close()
    await page.close()
  }

  console.log('\n━━━ P6 进度条不得压住导航顶缘高光 ━━━')
  {
    const page = await open('/guide/aml')
    const r = await page.evaluate(() => getComputedStyle(document.querySelector('.VPNavBar')).boxShadow)
    check('导航不再有顶缘 inset 高光(与进度条抢同两行)', !/inset/.test(r), r)
    const bar = await page.evaluate(() => {
      const st = getComputedStyle(document.body, '::before')
      return { content: st.content, z: st.zIndex }
    })
    check('阅读进度条仍存在', bar.content !== 'none' && bar.content !== '', JSON.stringify(bar))
    await page.close()
  }

  console.log('\n━━━ P8 / B4 390px 下中文标题不拆词、控制台标题不塌缩 ━━━')
  {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844 })
    await page.goto(`${base}/`, { waitUntil: 'networkidle2' })
    await new Promise(r => setTimeout(r, 700))
    const r = await page.evaluate(() => {
      const meta = document.querySelector('.aw-console-meta')
      const title = document.querySelector('.aw-console-title')
      const h1 = document.querySelector('.hw-title')
      return {
        metaDisplay: meta ? getComputedStyle(meta).display : '(none)',
        titleClient: title?.clientWidth ?? 0,
        titleScroll: title?.scrollWidth ?? 0,
        h1WordBreak: h1 ? getComputedStyle(h1).wordBreak : '',
        docScrollW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
      }
    })
    check('390px 无横向滚动', r.docScrollW <= r.winW + 1, `scrollW=${r.docScrollW} win=${r.winW}`)
    check('控制台标题获得足够宽度(不再只剩省略号)', r.titleClient >= 120, `client=${r.titleClient} scroll=${r.titleScroll} meta=${r.metaDisplay}`)
    check('hero 标题 word-break: keep-all', r.h1WordBreak === 'keep-all', r.h1WordBreak)
    await page.close()
  }
}
finally {
  await browser.close()
  server.close()
}

console.log(`\n${fail ? '✖' : '✅'} v3 视觉复验:${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
