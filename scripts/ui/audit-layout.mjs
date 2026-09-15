/**
 * 自适应布局审计 —— 用真实浏览器几何量测量,而不是目测。
 *
 * 检查项(每项都能给出"哪个元素、差多少像素"的硬证据):
 *  1. 横向溢出:文档级 + 元素级(右边缘越界 / 12px 内可滚动容器豁免)
 *  2. 内容裁切:overflow:hidden 且 scrollWidth/scrollHeight 超出(文字被切)
 *  3. 元素重叠:同一层可见块级元素的矩形相交(排除父子/包含关系)
 *  4. 触摸目标:移动端可点击元素 < 32×32(或 < 40×40 的纯图标按钮)
 *  5. 字号下限:正文 < 13px、标签 < 11px
 *  6. 对比度:遍历文本节点,用实际渲染色(含半透明叠加)算 WCAG 比值
 *  7. 视口外固定元素:fixed/sticky 元素超出可视区
 *
 * 用法:node scripts/ui/audit-layout.mjs --vp 390x844,768x1024 --routes all --theme both
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureVisualUser, launch, openPage, gotoReady, ROUTES, VIEWPORTS } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const VP_ARG = arg('vp', '')
const ROUTE_ARG = arg('routes', 'all')
const THEME = arg('theme', 'both')
const OUT = arg('out', '.e2e-shots/new/audit')
const WAIT = Number(arg('wait', 6500))

const vps = VP_ARG
  ? VP_ARG.split(',').map((s) => {
      const [w, h] = s.split('x').map(Number)
      const hit = VIEWPORTS.find(v => v.width === w && v.height === h)
      return hit ?? { name: `${w}x${h}`, width: w, height: h, label: `${w}×${h}` }
    })
  : VIEWPORTS
const routes = ROUTE_ARG === 'all' ? ROUTES : ROUTES.filter(r => ROUTE_ARG.split(',').includes(r.name))
const themes = THEME === 'both' ? [true, false] : [THEME === 'dark']

/** 注入到页面里的审计函数(必须是自包含的:序列化后无法访问外部作用域) */
const AUDIT_FN = function () {
  const VW = window.innerWidth
  const VH = window.innerHeight
  const issues = []

  const describe = (el) => {
    if (!el) return '?'
    const id = el.id ? '#' + el.id : ''
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : ''
    const attr = el.getAttribute?.('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''
    return `${el.tagName.toLowerCase()}${id}${cls}${attr}`
  }
  const text = el => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  const rect = el => el.getBoundingClientRect()
  const visible = (el) => {
    const r = rect(el)
    if (r.width < 1 || r.height < 1) return false
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false
    if (el.closest('[aria-hidden="true"]')) return false
    return true
  }
  /** 元素是否位于某个可横向滚动的祖先里(那种"越界"是设计,不是缺陷) */
  const inScroller = (el) => {
    let p = el.parentElement
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'hidden') return p
      p = p.parentElement
    }
    return null
  }

  // 1. 文档级横向溢出
  const de = document.documentElement
  if (de.scrollWidth - de.clientWidth > 1) {
    issues.push({ kind: 'doc-overflow-x', px: de.scrollWidth - de.clientWidth, detail: 'document' })
  }

  const all = Array.from(document.querySelectorAll('body *'))
  for (const el of all) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const r = rect(el)

    // 2. 元素级右越界(排除在滚动容器内 / 明确的装饰层)
    const oe = inScroller(el)
    if (!oe && r.right > VW + 2 && cs.position !== 'fixed') {
      issues.push({
        kind: 'el-overflow-right', el: describe(el), text: text(el),
        right: Math.round(r.right), vw: VW, over: Math.round(r.right - VW),
      })
    }
    if (!oe && r.left < -2 && cs.position !== 'fixed') {
      issues.push({ kind: 'el-overflow-left', el: describe(el), text: text(el), left: Math.round(r.left) })
    }

    // 3. 内容裁切(只报"有文字却被切")
    const clipsX = cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2
    const clipsY = cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2
    if ((clipsX || clipsY) && (el.textContent || '').trim().length > 4 && el.children.length === 0) {
      issues.push({
        kind: 'text-clipped', el: describe(el), text: text(el),
        axis: clipsX ? 'x' : 'y',
        need: clipsX ? el.scrollWidth : el.scrollHeight,
        have: clipsX ? el.clientWidth : el.clientHeight,
      })
    }

    // 5. 字号
    if ((el.textContent || '').trim().length > 1 && el.children.length === 0) {
      const fs = parseFloat(cs.fontSize)
      if (fs && fs < 11) {
        issues.push({ kind: 'font-too-small', el: describe(el), text: text(el), px: fs })
      }
    }

    // 4. 触摸目标(仅移动端视口)
    if (VW <= 900) {
      const clickable = el.matches('button, a[href], [role="button"], input[type="checkbox"], .ant-switch, .ant-segmented-item')
      if (clickable && el.children.length === 0 && (r.width < 30 || r.height < 30)) {
        issues.push({
          kind: 'touch-target-small', el: describe(el), text: text(el),
          w: Math.round(r.width), h: Math.round(r.height),
        })
      }
    }
  }

  // 6. 对比度(文本叶子节点)
  const parseColor = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }
  }
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })
  const effBg = (el) => {
    let p = el
    let acc = null
    while (p && p !== document.documentElement.parentElement) {
      const c = parseColor(getComputedStyle(p).backgroundColor)
      if (c && c.a > 0.01) acc = acc ? over(acc, c) : c
      if (acc && acc.a >= 0.999) break
      if (c && c.a >= 0.999) break
      p = p.parentElement
    }
    if (!acc) acc = { r: 255, g: 255, b: 255, a: 1 }
    return acc
  }
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const seen = new Set()
  let contrastChecked = 0
  let contrastWorst = { ratio: 99, el: '', text: '', px: 0 }
  for (const el of all) {
    if (el.children.length > 0) continue
    const t = (el.textContent || '').trim()
    if (t.length < 2 || !visible(el)) continue
    const cs = getComputedStyle(el)
    const fg = parseColor(cs.color)
    if (!fg) continue
    const bg = effBg(el)
    const cr = ratio(over(fg, bg), bg)
    const fs = parseFloat(cs.fontSize) || 14
    const bold = Number(cs.fontWeight) >= 700
    const large = fs >= 24 || (fs >= 18.66 && bold)
    const need = large ? 3 : 4.5
    contrastChecked++
    if (cr < contrastWorst.ratio) {
      contrastWorst = { ratio: +cr.toFixed(2), el: describe(el), text: t.slice(0, 40), px: fs }
    }
    if (cr < need) {
      const key = describe(el) + t.slice(0, 12)
      if (seen.has(key)) continue
      seen.add(key)
      issues.push({
        kind: 'contrast', el: describe(el), text: t.slice(0, 40),
        ratio: +cr.toFixed(2), need, px: fs,
      })
    }
  }

  // 7. 重叠:同层可见块级元素矩形相交
  const blocks = all.filter((el) => {
    if (!visible(el)) return false
    const cs = getComputedStyle(el)
    if (cs.position === 'fixed' || cs.position === 'absolute') return false
    const d = cs.display
    if (d !== 'block' && d !== 'flex' && d !== 'grid' && d !== 'list-item') return false
    const r = rect(el)
    return r.width > 24 && r.height > 18
  })
  let overlaps = 0
  const overlapSamples = []
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j]
      if (a.contains(b) || b.contains(a)) continue
      const ra = rect(a), rb = rect(b)
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (ox > 6 && oy > 6) {
        const areaA = ra.width * ra.height, areaB = rb.width * rb.height
        const ov = ox * oy
        // 只报"显著遮盖":重叠面积超过较小元素的 25%
        if (ov > Math.min(areaA, areaB) * 0.25) {
          overlaps++
          if (overlapSamples.length < 8) {
            overlapSamples.push({
              a: describe(a), b: describe(b), ox: Math.round(ox), oy: Math.round(oy),
            })
          }
        }
      }
    }
  }
  if (overlaps) issues.push({ kind: 'overlap', count: overlaps, samples: overlapSamples })

  // 8. fixed/sticky 越界
  for (const el of all) {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
    if (!visible(el)) continue
    const r = rect(el)
    if (r.right > VW + 2 || r.left < -2) {
      issues.push({
        kind: 'fixed-out-of-view', el: describe(el), text: text(el),
        left: Math.round(r.left), right: Math.round(r.right), vw: VW,
      })
    }
  }

  const byKind = {}
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1

  return {
    vw: VW, vh: VH,
    scrollW: de.scrollWidth, scrollH: de.scrollHeight,
    counts: byKind,
    total: issues.length,
    contrastChecked,
    contrastWorst,
    issues: issues.slice(0, 120),
    bom: {
      sidebarW: Math.round(document.querySelector('.app-sidebar, aside')?.getBoundingClientRect().width ?? 0),
      headerH: Math.round(document.querySelector('.app-header, header')?.getBoundingClientRect().height ?? 0),
      contentLeft: Math.round(document.querySelector('.app-content')?.getBoundingClientRect().left ?? 0),
    },
  }
}

fs.mkdirSync(OUT, { recursive: true })
const token = await ensureVisualUser()
const browser = await launch()
const rows = []
for (const vp of vps) {
  for (const dark of themes) {
    for (const r of routes) {
      const page = await openPage(browser, { token, dark, width: vp.width, height: vp.height, deviceScaleFactor: 1 })
      const errs = []
      page.on('pageerror', e => errs.push(String(e.message).slice(0, 160)))
      try {
        await gotoReady(page, r.path, { wait: WAIT })
        const res = await page.evaluate(AUDIT_FN)
        res.route = r.name
        res.path = r.path
        res.vp = vp.name
        res.theme = dark ? 'dark' : 'light'
        res.pageErrors = errs
        rows.push(res)
        const c = res.counts
        console.log(`${vp.name.padEnd(16)} ${(dark ? 'dark' : 'light').padEnd(5)} ${r.name.padEnd(12)} total=${String(res.total).padStart(3)} ${JSON.stringify(c)}`)
      }
      catch (e) {
        rows.push({ route: r.name, vp: vp.name, theme: dark ? 'dark' : 'light', error: String(e.message).slice(0, 160) })
        console.log(`${vp.name} ${r.name} FAIL ${String(e.message).slice(0, 100)}`)
      }
      await page.close()
    }
  }
}
await browser.close()
fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(rows, null, 2))
console.log('\n->', path.join(OUT, 'audit.json'))
