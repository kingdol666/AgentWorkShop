/**
 * Header 航迹标签页关闭功能验证:
 *  1. 访问多个页面 → 标签按序累积
 *  2. 悬停标签 → 关闭钮展开显示
 *  3. 关闭非当前页 → 标签移除、路由不变
 *  4. 关闭当前页 → 标签移除 + 跳转至左侧相邻航点(兜底仪表盘)
 *  5. 刷新后移除状态保持(localStorage 持久化)
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:3001'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = '.design-verify'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, path, { body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

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

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const stamp = Date.now().toString(36)
  const email = `tab-ui-${stamp}@test.local`
  await api('POST', '/api/users/register', { body: { name: `tabui-${stamp}`, email, password: 'Passw0rd!123' } })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  // 登录(冷编译时等待登录表单就绪,最多 30s)
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 30; i++) {
    if (await page.$('input[type="email"]')) break
    await sleep(1000)
  }
  await page.$eval('input[type="email"]', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, email)
  await page.$eval('input[type="password"]', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, 'Passw0rd!123')
  await sleep(200)
  for (const b of await page.$$('button')) {
    const txt = (await b.evaluate(el => el.textContent) || '').trim()
    if (txt.replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(3200)

  // 累积标签:仪表盘(/) → /tokens → /users → /monitor
  for (const path of ['/tokens', '/users', '/monitor']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await sleep(1400)
  }
  const tabs1 = await page.$$eval('.trail-node', nodes => nodes.map(n => n.textContent))
  check('T1 多页访问后标签累积(≥4)', tabs1.length >= 4, `tabs=${tabs1.length}`)
  await page.screenshot({ path: `${SHOT_DIR}/tab-01-trail.png` })

  // 悬停展开关闭钮
  await page.hover('.trail-node:nth-child(3)')
  await sleep(500)
  const closeVisible = await page.$eval('.trail-node:nth-child(3) .node-close', (el) => {
    const cs = getComputedStyle(el)
    return cs.opacity === '1' && cs.width !== '0px'
  })
  check('T2 悬停标签 → 关闭钮展开', closeVisible)
  await page.screenshot({ path: `${SHOT_DIR}/tab-02-hover-close.png` })

  // 关闭非当前页(当前是 /monitor;关第 3 个 = /users)
  const beforePath = await page.evaluate(() => location.pathname)
  const beforeCount = tabs1.length
  await page.click('.trail-node:nth-child(3) .node-close')
  await sleep(900)
  const tabs2 = await page.$$eval('.trail-node', nodes => nodes.map(n => n.textContent))
  check('T3 关闭非当前页 → 标签移除且路由不变',
    tabs2.length === beforeCount - 1 && await page.evaluate(() => location.pathname) === beforePath,
    `tabs=${tabs2.length} path=${await page.evaluate(() => location.pathname)}`)

  // 关闭当前页(当前 /monitor 是最后一项)
  await page.hover('.trail-node:last-child')
  await sleep(400)
  await page.click('.trail-node:last-child .node-close')
  await sleep(1200)
  const afterPath = await page.evaluate(() => location.pathname)
  const tabs3 = await page.$$eval('.trail-node', nodes => nodes.length)
  check('T4 关闭当前页 → 移除并跳转相邻航点',
    tabs3 === beforeCount - 2 && afterPath !== '/monitor' && afterPath !== '/',
    `tabs=${tabs3} → ${afterPath}`)
  await page.screenshot({ path: `${SHOT_DIR}/tab-03-after-close-active.png` })

  // 刷新保持
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2000)
  const tabs4 = await page.$$eval('.trail-node', nodes => nodes.length)
  check('T5 刷新后移除状态保持', tabs4 === tabs3, `tabs=${tabs4}`)
  const monitorBack = await page.$$eval('.trail-node', nodes => nodes.some(n => n.textContent.includes('运行时监控')))
  check('T6 被关页签不因刷新回补', !monitorBack)

  await browser.close()
  console.log(`\n${pass} pass / ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('UI 验证崩溃:', e)
  process.exit(1)
})
