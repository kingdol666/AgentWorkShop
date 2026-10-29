#!/usr/bin/env node

/**
 * e2e-idd-results-ui —— 结果库面板 UI 走查(A11)。
 * 前置:演示实例 3300 已开启 results_enabled + results_allow_annotate(由 e2e-idd-results 设置)。
 * 运行:node scripts/e2e-idd-results-ui.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3300'
const EVID = 'docs/audit/evidence/2026-10-25-idd-results'
mkdirSync(EVID, { recursive: true })
const results = []
function check(id, name, ok, detail = '') {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail).slice(0, 300) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail).slice(0, 260)}`}`)
}

const puppeteer = await import('file:///D:/codes/ABO/AgentWorkShop/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js').then(m => m.default)
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 980 })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(`${String(e.message).slice(0, 160)} @ ${String(e.stack ?? '').split('\n')[1]?.trim() ?? ''}`))
const reqLog = []
page.on('request', (r) => {
  if (r.url().includes('/api/plugins/diag-bridge')) reqLog.push(`REQ ${r.method()} ${r.url().replace(BASE, '')}`)
})
page.on('response', async (r) => {
  if (r.url().includes('/api/plugins/diag-bridge/results')) {
    let body
    try {
      const j = await r.json()
      body = ` total=${j?.data?.total} rows=${j?.data?.results?.length} success=${j?.success} error=${j?.error ?? '-'}`
    }
    catch { body = ' (body-unreadable)' }
    reqLog.push(`RES ${r.status()} ${r.url().replace(BASE, '')}${body}`)
  }
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function login() {
  const ok = await page.evaluate(async (email, pass) => {
    const inputs = [...document.querySelectorAll('input')]
    const textInput = inputs.find(i => i.type === 'email' || /邮箱|用户名/.test(i.placeholder ?? ''))
    const pwd = inputs.find(i => i.type === 'password')
    if (!textInput || !pwd) return `inputs-not-found(${inputs.length})`
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(textInput, email)
    set(pwd, pass)
    await new Promise(r => setTimeout(r, 300))
    const btn = [...document.querySelectorAll('button')].find(b => /登\s*录/i.test(b.textContent ?? '') && !b.disabled)
    if (!btn) return 'btn-not-found'
    btn.click()
    return 'clicked'
  }, 'admin@awshop.local', 'admin123')
  return ok
}

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 })
await sleep(4000)
let hasPwd = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')))
if (!hasPwd) {
  // dev 冷编译:等页面水合后登录框才出现
  for (let i = 0; i < 20 && !hasPwd; i += 1) {
    await sleep(1500)
    hasPwd = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')))
  }
}
if (hasPwd) {
  console.log('login:', await login())
  await sleep(3500)
}
else {
  // 无登录框 = 已登录(持久会话/免登录环境)。直接验证登录态,不要误判成"页面没起来":
  // 既有轮次实测过 hasPwd 轮询在特定时序下假阴,而应用壳已完整水合。
  const authed = await page.evaluate(() => /仪表盘|插件管理|用户管理/.test(document.body.textContent ?? ''))
  console.log('login:', authed ? 'already-authenticated(skip)' : 'no-password-box-and-not-authed(continuing)')
  await sleep(1500)
}
// 插件面板直接挂在 /plugins 页(无需点插件卡片)
await page.goto(BASE + '/plugins', { waitUntil: 'domcontentloaded', timeout: 120000 })
await sleep(4000)
check('A11.1', '插件页可打开', await page.evaluate(() => document.body.textContent.includes('插件')), (await page.title()).slice(0, 80))

// 等结果面板出现(标题「分析结果库」;dev 冷编译可能需 30s+)
let listReady = false
for (let i = 0; i < 40; i += 1) {
  listReady = await page.evaluate(() => document.body.textContent.includes('分析结果库(全部历史分析)'))
  if (listReady) break
  await sleep(1000)
}
check('A11.2', '结果库面板渲染(标题可见)', listReady)
await page.screenshot({ path: join(EVID, 'ui-results-list.png'), fullPage: true })

const listInfo = await page.evaluate(() => {
  const root = document.querySelector('[data-plugin-panel="diag-bridge/diag-results"]') ?? document
  const rows = [...root.querySelectorAll('tr')].filter(tr => tr.querySelectorAll('td').length >= 6)
  return { rows: rows.length, first: rows[0]?.textContent?.slice(0, 120) ?? '', total: (root.textContent ?? '').match(/共 (\d+) 条/)?.[1] ?? '-' }
})
check('A11.3', '列表渲染数据行', listInfo.rows > 0, JSON.stringify(listInfo))

if (listInfo.rows > 0) {
  // 点击第一行 → 详情
  const clicked = await page.evaluate(() => {
    const root = document.querySelector('[data-plugin-panel="diag-bridge/diag-results"]') ?? document
    const row = [...root.querySelectorAll('tr')].find(tr => tr.querySelectorAll('td').length >= 6)
    if (!row) return false
    row.click()
    return true
  })
  check('A11.4', '点击结果行进入详情', clicked)
  let detailReady = false
  for (let i = 0; i < 15; i += 1) {
    detailReady = await page.evaluate(() => document.body.textContent.includes('关键数字') || document.body.textContent.includes('HTML 报告'))
    if (detailReady) break
    await sleep(800)
  }
  check('A11.5', '详情区渲染(关键数字/HTML)', detailReady)
  await page.screenshot({ path: join(EVID, 'ui-results-detail.png'), fullPage: true })

  const editState = await page.evaluate(() => {
    const root = document.querySelector('[data-plugin-panel="diag-bridge/diag-results"]') ?? document
    const hasEdit = (root.textContent ?? '').includes('编辑元数据')
    const hasReadonly = (root.textContent ?? '').includes('元数据编辑未开放')
    const hasSave = [...root.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === '保存')
    return { hasEdit, hasReadonly, hasSave }
  })
  check('A11.6', '编辑区按服务端能力显示(admin+已开启→可编辑)', editState.hasSave && !editState.hasReadonly, JSON.stringify(editState))

  if (editState.hasSave) {
    // 填写并保存 → 回显
    const saved = await page.evaluate(async () => {
      const ta = [...document.querySelectorAll('textarea')].pop()
      const inputs = [...document.querySelectorAll('input[type="text"]')]
      const tags = inputs[inputs.length - 1]
      const set = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (!ta) return { ok: false, reason: 'no-textarea' }
      set(ta, `UI 走查 ${new Date().toISOString().slice(0, 16)}`)
      if (tags) set(tags, 'ui-walkthrough,results')
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '保存')
      if (!btn) return { ok: false, reason: 'no-save' }
      btn.click()
      return { ok: true }
    })
    check('A11.7', '点击保存提交编辑', saved.ok, JSON.stringify(saved))
    let savedMsg = false
    for (let i = 0; i < 12; i += 1) {
      savedMsg = await page.evaluate(() => document.body.textContent.includes('已保存'))
      if (savedMsg) break
      await sleep(700)
    }
    check('A11.8', '保存成功回显(已保存)', savedMsg)
    await page.screenshot({ path: join(EVID, 'ui-results-edit.png'), fullPage: true })
  }
  else {
    check('A11.7', '保存按钮可见', false, JSON.stringify(editState))
    check('A11.8', '保存成功回显', false, 'skipped')
  }
}

check('A11.9', 'UI 走查无未捕获 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(';'))
console.log('--- diag-bridge 请求轨迹 ---')
console.log(reqLog.slice(0, 12).join('\n') || '(无请求)')
await browser.close()
const pass = results.filter(r => r.pass).length
writeFileSync(join(EVID, 'ui-report.json'), JSON.stringify({ script: 'scripts/e2e-idd-results-ui.mjs', generatedAt: new Date().toISOString(), pass, total: results.length, results }, null, 2))
console.log(`\nIDD-RESULTS UI E2E: ${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
