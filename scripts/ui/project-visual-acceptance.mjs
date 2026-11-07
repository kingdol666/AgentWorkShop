/**
 * Project 页面视觉/交互验收：亮暗 × 桌面/移动，覆盖概览、计划、交付物、审批、决策与事件、
 * AntD 下拉浮层、对话输入焦点、横向溢出与控制台错误。
 *
 * 运行：node scripts/ui/project-visual-acceptance.mjs [projectId]
 * 环境：AW_BASE（默认 http://127.0.0.1:3982）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3982'
const { launch, openPage, gotoReady, sleep, api } = await import('./lib.mjs')

const OUT = 'docs/audit/evidence/2026-11-06-ui-polish'
const SHOTS = join(OUT, 'shots')
mkdirSync(SHOTS, { recursive: true })

const login = await api('POST', '/api/users/login', {
  body: { email: 'router@aw.local', password: 'Router2026!' },
})
if (login.code !== 0) throw new Error(`登录失败：${login.message}`)
const token = login.data.token

const projectId = process.argv[2] ?? 'a1955fd9-e3ff-45fa-919d-a4fa1b61a576'
const browser = await launch()
const report = { base: process.env.AW_BASE, projectId, generatedAt: new Date().toISOString(), runs: [], errors: [] }

async function shot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(250)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false })
}

async function clickTab(page, key) {
  await page.click(`[data-testid="tab-${key}"]`)
  await sleep(350)
}

async function collect(page) {
  return page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1]
      return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }
    }
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    })
    const lum = (c) => {
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const effBg = (el) => {
      let n = el
      const stack = []
      while (n) {
        const cs = getComputedStyle(n)
        const c = parse(cs.backgroundColor)
        if (c.a > 0) stack.push(c)
        n = n.parentElement
      }
      let base = { r: 255, g: 255, b: 255, a: 1 }
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base)
      return base
    }
    const check = (sel, label) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      const fg = parse(cs.color)
      const bg = effBg(el)
      return { label, text: (el.textContent ?? '').trim().slice(0, 36), color: cs.color, bg: cs.backgroundColor, ratio: +ratio(over(fg, bg), bg).toFixed(2), px: cs.fontSize }
    }
    return {
      theme: document.documentElement.className,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      nativeSelects: document.querySelectorAll('select').length,
      antSelects: document.querySelectorAll('.ant-select').length,
      checks: [
        check('.chat-body', 'chat body'),
        check('.chat-hint', 'chat hint'),
        check('.kpi-value', 'kpi value'),
        check('.tab.active', 'active tab'),
        check('.card-sub', 'card sub'),
      ].filter(Boolean),
    }
  })
}

for (const dark of [true, false]) {
  for (const vp of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
    const page = await openPage(browser, { token, dark, width: vp.width, height: vp.height, deviceScaleFactor: 1 })
    const errs = []
    page.on('pageerror', e => errs.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 200)}`)
    })

    // 列表页
    await gotoReady(page, '/projects', { wait: 1800 })
    await shot(page, `list-${dark ? 'dark' : 'light'}-${vp.name}`)

    // 详情页概览
    await gotoReady(page, `/projects/${projectId}`, { wait: 2200 })
    await shot(page, `detail-${dark ? 'dark' : 'light'}-${vp.name}`)
    const overview = await collect(page)

    // 计划与工作
    await clickTab(page, 'plan')
    await shot(page, `plan-${dark ? 'dark' : 'light'}-${vp.name}`)

    // 交付物 + 下拉浮层
    await clickTab(page, 'deliverables')
    await shot(page, `deliverables-${dark ? 'dark' : 'light'}-${vp.name}`)
    let selectProbe = null
    const sel = await page.$('[data-testid="select-deliverable-channel"] .ant-select-selector')
    if (sel) {
      await sel.click()
      await sleep(450)
      await page.screenshot({ path: join(SHOTS, `select-${dark ? 'dark' : 'light'}-${vp.name}.png`), fullPage: false })
      selectProbe = await page.evaluate(() => {
        const dd = document.querySelector('.ant-select-dropdown')
        if (!dd) return null
        const cs = getComputedStyle(dd)
        const item = dd.querySelector('.ant-select-item-option')
        return {
          bg: cs.backgroundColor,
          color: cs.color,
          visible: !dd.className.includes('hidden'),
          itemBg: item ? getComputedStyle(item).backgroundColor : null,
          itemColor: item ? getComputedStyle(item).color : null,
        }
      })
      // 真实选择一条：验证 AntD 浮层可点、v-model 回填
      await page.evaluate(() => {
        const dd = [...document.querySelectorAll('.ant-select-dropdown')].find(d => !d.className.includes('hidden'))
        dd?.querySelector('.ant-select-item-option')?.click()
      })
      await sleep(350)
      const picked = await page.evaluate(() => document.querySelector('[data-testid="select-deliverable-channel"] .ant-select-selection-item')?.textContent?.trim() ?? '')
      if (selectProbe) selectProbe.picked = picked
      await page.keyboard.press('Escape')
      await sleep(200)
    }

    // 审批 / 事件
    await clickTab(page, 'approvals')
    await shot(page, `approvals-${dark ? 'dark' : 'light'}-${vp.name}`)
    await clickTab(page, 'events')
    await shot(page, `events-${dark ? 'dark' : 'light'}-${vp.name}`)

    // 回到概览：继续开发按钮聚焦输入框；移动端滚到对话卡看 composer
    await clickTab(page, 'overview')
    let focusOk = null
    const cont = await page.$('[data-testid="continue-project"]')
    if (cont) {
      await cont.click()
      await sleep(500)
      focusOk = await page.evaluate(() => {
        const send = document.querySelector('[data-testid="project-continue-send"]')?.getBoundingClientRect()
        return {
          active: document.activeElement?.getAttribute('data-testid') ?? null,
          sendVisible: Boolean(send && send.top >= 0 && send.bottom <= window.innerHeight),
        }
      })
      await page.type('[data-testid="project-continue-input"]', '回归验证')
      await sleep(200)
      focusOk.composerEnabled = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="project-continue-send"]')
        return Boolean(btn && !btn.disabled)
      })
      await page.screenshot({ path: join(SHOTS, `chat-${dark ? 'dark' : 'light'}-${vp.name}.png`), fullPage: false })
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyA')
      await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
      await sleep(150)
    }

    // 横向溢出复检（滚动到对话卡后）
    const after = await collect(page)
    report.runs.push({
      theme: dark ? 'dark' : 'light',
      viewport: vp.name,
      overview,
      afterTabs: after,
      selectProbe,
      focusOk,
      errors: errs,
    })
    report.errors.push(...errs.map(e => `[${dark ? 'dark' : 'light'}/${vp.name}] ${e}`))
    await page.close()
  }
}

writeFileSync(join(OUT, 'acceptance.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.runs.map(r => ({
  theme: r.theme,
  viewport: r.viewport,
  overflowX: r.afterTabs.overflowX,
  nativeSelects: r.afterTabs.nativeSelects,
  antSelects: r.afterTabs.antSelects,
  focusOk: r.focusOk,
  select: r.selectProbe,
  checks: r.afterTabs.checks,
  errors: r.errors.length,
})), null, 2))
console.log('errors:', report.errors)
setTimeout(() => process.exit(0), 4000)
await browser.close().catch(() => {})
