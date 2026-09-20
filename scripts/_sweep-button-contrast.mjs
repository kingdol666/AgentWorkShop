/** 全站按钮渲染扫描:双主题 × 全页面,检测 (a) 文字色≈背景色(隐形文本) (b) 无文字无图标的空按钮。 */
import { ensureVisualUser, launch, openPage, gotoReady, sleep, ROUTES } from './ui/lib.mjs'

const token = await ensureVisualUser()
const browser = await launch({ width: 1440, height: 900 })

const problems = []
for (const dark of [false, true]) {
  const page = await openPage(browser, { token, dark, width: 1440, height: 900 })
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('aw.locale', 'zh-CN')
    }
    catch { /* 忽略 */ }
  })
  for (const r of ROUTES) {
    try {
      await gotoReady(page, r.path, { wait: 2200 })
      await sleep(600)
      const found = await page.evaluate(() => {
        const out = []
        const parse = (c) => {
          const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
          if (!m) return null
          return { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] }
        }
        const lum = (c) => {
          const f = (v) => {
            v /= 255
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
        }
        const ratio = (a, b) => {
          const l1 = lum(a), l2 = lum(b)
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        }
        const over = (fg, alpha, base) => fg.map((v, i) => Math.round(v * alpha + base[i] * (1 - alpha)))
        const pageBg = getComputedStyle(document.body).backgroundColor
        const pbNums = pageBg.match(/\d+/g)
        const pb = pbNums?.map(Number) ?? [255, 255, 255]
        for (const btn of document.querySelectorAll('button, .pill-btn, .ghost-btn, .mini-btn, a.pill-btn')) {
          const r = btn.getBoundingClientRect()
          if (r.width < 4 || r.height < 4) continue
          if (btn.offsetParent === null && getComputedStyle(btn).position !== 'fixed') continue
          const cs = getComputedStyle(btn)
          const fg = parse(cs.color)
          let bg = parse(cs.backgroundColor)
          if (!fg) continue
          // 逐层向上找不透明背景
          let eff = bg && bg.a >= 0.95 ? bg.c : null
          if (!eff) {
            let el = btn
            while (el && el !== document.documentElement) {
              const c = parse(getComputedStyle(el).backgroundColor)
              if (c && c.a >= 0.95) {
                eff = c.c
                break
              }
              el = el.parentElement
            }
            if (!eff) eff = pb
          }
          if (bg && bg.a < 0.95 && bg.a > 0) eff = over(bg.c, bg.a, eff)
          const cr = ratio(fg.c, eff)
          const label = (btn.innerText ?? '').replace(/\s+/g, ' ').trim()

          const hasIcon = btn.querySelector('span[class*="i-"], svg') !== null
          const isSwitch = /switch/i.test(btn.className) || btn.getAttribute('role') === 'switch'
          if (isSwitch) continue
          if (cr < 1.35) out.push({ kind: 'low-contrast', cr: cr.toFixed(2), label: label.slice(0, 30), cls: btn.className.slice(0, 50), color: cs.color, bg: cs.backgroundColor })
          else if (!label && !hasIcon && !btn.getAttribute('aria-label') && !btn.getAttribute('title')) out.push({ kind: 'empty-button', label: '(no text)', cls: btn.className.slice(0, 50) })
        }
        return out
      })
      for (const p of found) problems.push({ theme: dark ? 'dark' : 'light', route: r.path, ...p })
      if (found.length) console.log(`[${dark ? 'dark' : 'light'}] ${r.path}: ${found.length} 个可疑`)
    }
    catch (e) {
      console.log(`[ERR] ${r.path}: ${String(e).slice(0, 100)}`)
    }
  }
  await page.close()
}
await browser.close()
console.log(`\n===== 扫描完成:${problems.length} 个可疑点 =====`)
for (const p of problems) console.log(`[${p.theme}] ${p.route} ${p.kind} cr=${p.cr ?? ''} "${p.label}" cls=${p.cls}`)
