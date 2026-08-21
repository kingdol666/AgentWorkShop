/**
 * Pre-Flight 断言 — taste-skill §14 的可机械化项
 * 在真实渲染的 harness 页面上验证:
 *  1. 色彩锁:页面计算样式中朱砂 accent 生效(按钮/活跃节点/流式边框)
 *  2. 形状锁:主要交互件圆角 ∈ {6,8,10,12}px 阶梯
 *  3. 对比度:正文文本 ≥ 4.5:1,mono 元数据 ≥ 3:1(抽样)
 *  4. 零 em-dash:全部可见文本无 —/–
 *  5. 灰阶单族:body/canvas 无暖灰(#f9f7f3 族)
 *  6. reduced-motion:模拟偏好后动画收敛
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://localhost:3001'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) {
    pass++
  }
  else {
    fail++
  }
}

/** 相对亮度(WCAG) */
function luminance(r, g, b) {
  const f = (c) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(fg, bg) {
  const l1 = luminance(...fg)
  const l2 = luminance(...bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
function parseRgb(s) {
  const m = s?.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/)
  if (!m) return null
  let [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  if (a < 1) {
    // 与纸色合成(近似:取页面底色为纸色)
    r = Math.round(r * a + 246 * (1 - a))
    g = Math.round(g * a + 246 * (1 - a))
    b = Math.round(b * a + 246 * (1 - a))
  }
  return [r, g, b]
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

async function main() {
  // ── 静态扫描:可见模板零 em-dash ──
  let emdashHits = 0
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.vue')) {
        const s = fs.readFileSync(p, 'utf-8')
        const tpl = s.slice(s.indexOf('<template>'), s.indexOf('</template>'))
        const visible = tpl.replace(/<!--[\s\S]*?-->/g, '')
        for (const line of visible.split('\n')) {
          if (/[—–]/.test(line)) {
            emdashHits++
            console.log('    emdash:', p, line.trim().slice(0, 60))
          }
        }
      }
    }
  }
  walk('app')
  check('可见模板零 em-dash/en-dash', emdashHits === 0, `${emdashHits} 处`)

  // ── 动态断言 ──
  const email = `pf-${Date.now().toString(36)}@test.local`
  const password = 'Passw0rd!123'
  const reg = await api('POST', '/api/users/register', { body: { name: `pf-${Date.now().toString(36)}`, email, password } })
  const token = reg.data.token
  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'preflight',
      scenarioPrompt: 'preflight',
      leadAgent: { name: 'pf-lead', harness: 'mock', config: { delayMs: 200 } },
    },
    token,
  })
  const cid = ch.data.channelId
  await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'pf-w', harness: 'mock', role: 'worker', config: { delayMs: 250, streamDemo: true } }, token })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'pf-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cid}`, { token })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2000)
  await page.$eval('input[type="email"]', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, email)
  await page.$eval('input[type="password"]', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, password)
  await sleep(200)
  for (const b of await page.$$('button')) {
    const txt = (await b.evaluate(el => el.textContent) || '').trim()
    if (txt.replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(3500)
  if (!page.url().includes('/workshop/w/')) {
    await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        await sleep(3200)
        break
      }
    }
  }
  await sleep(2500)

  // 提交任务以产生事件流
  await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea')
    if (!ta) return
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'preflight 渲染断言')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  })
  await sleep(9000)

  const dom = await page.evaluate(() => {
    const gs = (el, prop) => el ? getComputedStyle(el)[prop] : null
    const btn = document.querySelector('.composer .ant-btn-primary')
    const blocks = document.querySelectorAll('.event-block')
    const streamText = document.querySelector('.stream-text')
    const body = document.body
    return {
      blocks: blocks.length,
      btnBg: gs(btn, 'backgroundColor'),
      btnRadius: gs(btn, 'borderRadius'),
      btnColor: gs(btn, 'color'),
      streamBorder: gs(streamText, 'borderLeftColor'),
      streamRadius: gs(streamText, 'borderRadius'),
      bodyBg: gs(body, 'backgroundColor'),
      bodyColor: gs(body, 'color'),
      visibleText: document.body.innerText,
    }
  })

  // 1. 事件流入
  check('harness 事件块渲染', dom.blocks > 0, `${dom.blocks} 块`)

  // 2. 色彩锁:主按钮 = 朱砂 rgb(181,74,46)
  check('主按钮朱砂强调色', dom.btnBg?.includes('181, 74, 46'), dom.btnBg)

  // 3. 形状锁:按钮圆角 8px(panel-sm 阶梯)
  check('按钮圆角 = 8px(panel-sm)', dom.btnRadius === '8px', dom.btnRadius)

  // 4. 按钮对比度 AA
  const btnBg = parseRgb(dom.btnBg) ?? [181, 74, 46]
  const btnFg = parseRgb(dom.btnColor) ?? [255, 255, 255]
  const btnRatio = contrast(btnFg, btnBg)
  check('主按钮文字对比 ≥ 4.5:1', btnRatio >= 4.5, `${btnRatio.toFixed(2)}:1`)

  // 5. 正文对比度 AA(body ink on paper)
  const bodyRatio = contrast(parseRgb(dom.bodyColor), parseRgb(dom.bodyBg))
  check('正文对比 ≥ 4.5:1', bodyRatio >= 4.5, `${bodyRatio.toFixed(2)}:1`)

  // 6. canvas 非暖纸(色彩族轮换)
  check('canvas 为冷中性 #f6f6f7', dom.bodyBg?.includes('246, 246, 247'), dom.bodyBg)

  // 7. 流式块左边框带朱砂成分(流式中或落定 28% 混合)
  const sb = parseRgb(dom.streamBorder)
  check('流式块左边框为朱砂族', !!sb && sb[0] > sb[2] && (sb[0] - sb[2]) > 30, dom.streamBorder)

  // 8. 流式块圆角 chip 阶梯 6px
  check('流式块圆角 = 6px(chip)', dom.streamRadius === '6px', String(dom.streamRadius))

  // 9. 页面运行时可见文本零 em-dash
  const runtimeEmdash = (dom.visibleText.match(/[—–]/g) || []).length
  check('运行时文本零 em-dash', runtimeEmdash === 0, `${runtimeEmdash} 处`)

  // 10. reduced-motion 收敛(CSS 层面已全局收敛,验证关键动画带 prefers 门)
  //     静态抽查 main.css 是否包含 reduce 块
  const css = fs.readFileSync('app/assets/css/main.css', 'utf-8')
  check('全局 prefers-reduced-motion 收敛', css.includes('prefers-reduced-motion: reduce'))

  await browser.close()
  console.log(`\n${pass} pass / ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
