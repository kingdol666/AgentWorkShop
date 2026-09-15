/**
 * 自适应验收门 —— 全站 × 视口矩阵 × 明暗双主题的**可判定**检查。
 *
 * 和 audit-layout.mjs 的区别:audit 是"体检报告"(尽量多报,供人工判断),
 * verify 是"门禁"(只报确定是缺陷的,并给出通过/失败)。
 * 判定阈值都在下面 THRESHOLDS 里,改阈值必须写理由 —— 这是全站验收的唯一口径。
 *
 * 用法: node scripts/ui/verify-responsive.mjs [--routes all] [--theme both] [--json out.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureVisualUser, launch, openPage, gotoReady, ROUTES, VIEWPORTS } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const ROUTE_ARG = arg('routes', 'all')
const THEME = arg('theme', 'both')
const VP_ARG = arg('vp', '')
const WAIT = Number(arg('wait', 3500))
const JSON_OUT = arg('json', '.e2e-shots/verify/verify.json')
const routes = ROUTE_ARG === 'all' ? ROUTES : ROUTES.filter(r => ROUTE_ARG.split(',').includes(r.name))
const themes = THEME === 'both' ? [true, false] : [THEME === 'dark']
// --vp 收窄视口矩阵(联调期用;终验不带该参数,跑全矩阵)
const viewports = VP_ARG
  ? VP_ARG.split(',').map((s) => {
      const [w, h] = s.split('x').map(Number)
      return VIEWPORTS.find(v => v.width === w && v.height === h) ?? { name: `${w}x${h}`, width: w, height: h, label: `${w}×${h}` }
    })
  : VIEWPORTS

/**
 * 验收阈值(唯一口径)。
 * - minFontPhone 11:窄屏(≤640)手持视距下,10px mono 标签只剩 6px 有效字号,读不了。
 * - minFontDesktop 9.5:桌面保留"仪器铭牌"的 10px mono 微字是刻意的设计语言,
 *   但低于 9.5px 连铭牌都算不上,一律判失败。
 * - contrast AA:WCAG 2.1 正文 4.5:1。小字号的 mono 标签没有"large text"豁免。
 */
const THRESHOLDS = {
  minFontPhone: 11,
  minFontDesktop: 9.5,
  minTouch: 30,
  minContrast: 4.5,
}

const AUDIT = function (th) {
  const VW = window.innerWidth
  const issues = []
  const isSvg = el => el.namespaceURI === 'http://www.w3.org/2000/svg'
  const describe = (el) => {
    const cls = (typeof el.className === 'string' && el.className)
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : ''
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`
  }
  const txt = el => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)
  const rect = el => el.getBoundingClientRect()
  const visible = (el) => {
    const r = rect(el)
    if (r.width < 1 || r.height < 1) return false
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false
    if (el.closest('[aria-hidden="true"]')) return false
    // 被祖先的 overflow:hidden 整体推出可视区 = 看不见。
    // 缺这一条会把 antd Switch 的"另一态文案"也算成可见文本(它在轨道外,被裁掉),
    // 于是稳定报出 1.83:1 的假阳性(实测)。
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pcs = getComputedStyle(p)
      if (pcs.overflow === 'visible' && pcs.overflowX === 'visible' && pcs.overflowY === 'visible') continue
      const pr = p.getBoundingClientRect()
      if (
        r.right <= pr.left + 0.5 || r.left >= pr.right - 0.5
        || r.bottom <= pr.top + 0.5 || r.top >= pr.bottom - 0.5
      ) return false
    }
    return true
  }
  const inScroller = (el) => {
    let p = el.parentElement
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (['auto', 'scroll', 'hidden'].includes(cs.overflowX)) return p
      p = p.parentElement
    }
    return null
  }

  const de = document.documentElement
  if (de.scrollWidth - de.clientWidth > 1) issues.push({ kind: 'doc-overflow-x', px: de.scrollWidth - de.clientWidth })

  const all = Array.from(document.querySelectorAll('body *'))

  // 侧栏形态(结构性断言:窄屏必须在文档流外)
  const sider = document.querySelector('.app-sider')
  const siderCs = sider ? getComputedStyle(sider) : null
  const expectDrawer = VW < 900
  if (sider && siderCs) {
    const isFixed = siderCs.position === 'fixed'
    if (expectDrawer && !isFixed) issues.push({ kind: 'nav-should-be-drawer', actual: siderCs.position, vw: VW })
    if (!expectDrawer && isFixed) issues.push({ kind: 'nav-should-be-inline', actual: siderCs.position, vw: VW })
    if (expectDrawer) {
      const r = rect(sider)
      if (r.right > 1) issues.push({ kind: 'drawer-not-offcanvas', right: Math.round(r.right) })
    }
  }

  for (const el of all) {
    if (isSvg(el)) continue // SVG 内部(ECharts 轴标签等)不是布局缺陷来源
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    const r = rect(el)
    const scroller = inScroller(el)

    if (!scroller && cs.position !== 'fixed' && r.right > VW + 2) {
      issues.push({ kind: 'el-overflow-right', el: describe(el), text: txt(el), over: Math.round(r.right - VW) })
    }
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim()
      if (t.length > 1) {
        const fs = parseFloat(cs.fontSize)
        const floor = VW <= 640 ? th.minFontPhone : th.minFontDesktop
        if (fs && fs < floor) issues.push({ kind: 'font-too-small', el: describe(el), text: t.slice(0, 30), px: fs, floor })
      }
    }
    if (VW <= 900) {
      const clickable = el.matches('button, a[href], [role="button"], .ant-switch, .ant-segmented-item, .ant-checkbox-wrapper')
      // 命中区可以被伪元素外扩(把 16×16 的图标变成 40px 可点目标 —— 这是正当做法,
      // 而且比"把图标本身画大"更尊重既有密度)。只看 rect 会把"做得对"判成"做得错",
      // 所以要连伪元素一起量:要么它有实际的宽高,要么它用负 inset 撑开四边。
      const hit = (pseudo) => {
        const cs2 = getComputedStyle(el, pseudo)
        if (!cs2 || cs2.content === 'none' || cs2.position !== 'absolute') return false
        const w = Number.parseFloat(cs2.width)
        const h = Number.parseFloat(cs2.height)
        if (Number.isFinite(w) && Number.isFinite(h) && w >= th.minTouch && h >= th.minTouch) return true
        const inset = ['top', 'left', 'right', 'bottom'].map(s => Number.parseFloat(cs2[s]))
        return inset.every(v => Number.isFinite(v) && v <= -8)
      }
      const expanded = hit('::after') || hit('::before')
      // 带文字的按钮/链接:宽度由文案决定,不该按 40px 判死;真正的要求是**高度**够。
      // 纯图标控件(无文字)才要求两个方向都够,或已被伪元素外扩。
      const hasText = txt(el).length > 0
      const tooSmall = hasText
        ? r.height < th.minTouch
        : (r.width < th.minTouch || r.height < th.minTouch)
      if (clickable && el.children.length === 0 && !expanded && tooSmall) {
        issues.push({ kind: 'touch-target-small', el: describe(el), text: txt(el), w: Math.round(r.width), h: Math.round(r.height) })
      }
    }
    if (cs.position === 'fixed' && (r.right > VW + 2 || r.left < -2) && el !== sider && !el.closest('.app-sider')) {
      issues.push({ kind: 'fixed-out-of-view', el: describe(el), text: txt(el), left: Math.round(r.left), right: Math.round(r.right) })
    }
  }

  // 对比度
  const parseColor = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }
  }
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  })
  const effBg = (el) => {
    let p = el, acc = null
    while (p && p !== document.documentElement.parentElement) {
      const c = parseColor(getComputedStyle(p).backgroundColor)
      if (c && c.a > 0.01) acc = acc ? over(acc, c) : c
      if (acc && acc.a >= 0.999) break
      if (c && c.a >= 0.999) break
      p = p.parentElement
    }
    return acc ?? { r: 255, g: 255, b: 255, a: 1 }
  }
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => {
    const l1 = lum(a)
    const l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const seen = new Set()
  let worst = { ratio: 99, el: '', text: '' }
  for (const el of all) {
    if (isSvg(el) || el.children.length > 0) continue
    const t = (el.textContent || '').trim()
    if (t.length < 2 || !visible(el)) continue
    // 非活动控件豁免:WCAG 1.4.3 明确把"未激活的界面组件"排除在对比度要求之外,
    // 而 antd 的 disabled 文本用的是 ~25% 不透明度(实测 2.2:1 是**设计如此**)。
    // 把它们算作失败,等于要求一个不存在的标准。
    if (el.closest('[disabled], .ant-btn-disabled, [aria-disabled="true"], .ant-select-disabled')) continue
    const cs = getComputedStyle(el)
    const fg = parseColor(cs.color)
    if (!fg) continue
    // 背景是渐变/图片时对比度**无法**从计算样式推导(背景色只是垫底那一层)。
    // 把这种元素报成"不达标"是假阳性 —— 实测 .avatar-fallback(绿青渐变 + 墨字)
    // 被算成 1.06:1,而真实观感远高于 AA。宁可漏报,不要制造噪音。
    let onImage = false
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (getComputedStyle(p).backgroundImage !== 'none') {
        onImage = true
        break
      }
    }
    if (onImage) continue
    const bg = effBg(el)
    const cr = ratio(over(fg, bg), bg)
    const fs = parseFloat(cs.fontSize) || 14
    const bold = Number(cs.fontWeight) >= 700
    const large = fs >= 24 || (fs >= 18.66 && bold)
    const need = large ? 3 : th.minContrast
    if (cr < worst.ratio) worst = { ratio: +cr.toFixed(2), el: describe(el), text: t.slice(0, 30) }
    if (cr < need) {
      const key = describe(el) + t.slice(0, 10)
      if (seen.has(key)) continue
      seen.add(key)
      const hex = (c) => {
        const h = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
        return '#' + h(c.r) + h(c.g) + h(c.b)
      }
      issues.push({
        kind: 'contrast', el: describe(el), text: t.slice(0, 30),
        ratio: +cr.toFixed(2), need, px: fs, fg: hex(over(fg, bg)), bg: hex(bg),
      })
    }
  }

  const counts = {}
  for (const i of issues) counts[i.kind] = (counts[i.kind] || 0) + 1
  return {
    vw: VW, counts, total: issues.length, worstContrast: worst,
    issues: issues.slice(0, 60),
    nav: siderCs ? { pos: siderCs.position, w: Math.round(rect(sider).width) } : null,
  }
}

fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
const token = await ensureVisualUser()
const browser = await launch()
const rows = []
let failures = 0

for (const vp of viewports) {
  for (const dark of themes) {
    for (const r of routes) {
      const page = await openPage(browser, { token, dark, width: vp.width, height: vp.height, deviceScaleFactor: 1 })
      const errs = []
      page.on('pageerror', e => errs.push(String(e.message).slice(0, 160)))
      try {
        await gotoReady(page, r.path, { wait: WAIT })
        const res = await page.evaluate(AUDIT, THRESHOLDS)
        res.route = r.name
        res.path = r.path
        res.vp = vp.name
        res.theme = dark ? 'dark' : 'light'
        res.pageErrors = errs
        const bad = res.total + errs.length
        if (bad) failures++
        rows.push(res)
        console.log(`${bad ? 'FAIL' : ' ok '} ${vp.name.padEnd(16)} ${(dark ? 'dark' : 'light').padEnd(5)} ${r.name.padEnd(12)} ${JSON.stringify(res.counts)}${errs.length ? ' errs=' + errs.length : ''}`)
      }
      catch (e) {
        failures++
        rows.push({ route: r.name, vp: vp.name, theme: dark ? 'dark' : 'light', error: String(e.message).slice(0, 200) })
        console.log(`FAIL ${vp.name} ${r.name} — ${String(e.message).slice(0, 90)}`)
      }
      await page.close()
    }
  }
}

await browser.close()
fs.writeFileSync(JSON_OUT, JSON.stringify({ thresholds: THRESHOLDS, failures, rows }, null, 2))
const total = rows.length
console.log(`\n=== ${total} 个组合:${total - failures} 通过 / ${failures} 失败 ===`)
console.log('报告 →', JSON_OUT)
process.exit(failures ? 1 : 0)
