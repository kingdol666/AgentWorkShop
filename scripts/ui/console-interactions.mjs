#!/usr/bin/env node
/**
 * 控制台交互冒烟(ChatGPT 化布局 2026-11-07):真实浏览器点击/输入,
 * 覆盖 图标轨视图切换 / 侧栏频道切换 / 会话分组跳转 / Composer 发送。
 * 运行: AW_BASE=http://127.0.0.1:3002 node scripts/ui/console-interactions.mjs
 */
import { launch, openPage } from './lib.mjs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'
let passed = 0, failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (ok) passed += 1
  else failed += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function ownerToken() {
  const res = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
  })
  return (await res.json())?.data?.token ?? ''
}

const token = await ownerToken()
if (!token) throw new Error('owner 登录失败')
const wsRes = await fetch(`${BASE}/api/workshop/workspaces`, { headers: { authorization: `Bearer ${token}` } })
const wsList = (await wsRes.json())?.data ?? []
const wsId = Array.isArray(wsList) ? wsList[0]?.id : null
if (!wsId) throw new Error('无 workspace')

const browser = await launch({ width: 1440, height: 900 })
const page = await openPage(browser, { token, dark: false, width: 1440, height: 900 })
const errors = []
page.on('pageerror', e => errors.push(String(e?.message ?? e).slice(0, 200)))

await page.goto(`${BASE}/workshop/w/${wsId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(5000)

// ① 壳层三区:图标轨 + 侧栏 + Composer
const shell = await page.evaluate(() => ({
  rail: !!document.querySelector('.rail'),
  railViews: document.querySelectorAll('.rail-views .rail-btn').length,
  sideChannels: document.querySelectorAll('.channel-item').length,
  composer: !!document.querySelector('.composer textarea'),
  topbar: document.querySelector('.chan-title')?.textContent?.trim() ?? '',
}))
check('图标轨渲染(含 7 个视图位)', shell.rail && shell.railViews === 7, JSON.stringify(shell))
check('侧栏频道列表渲染', shell.sideChannels > 0, `channels=${shell.sideChannels}`)
check('Composer 输入框就位', shell.composer)
check('标题条显示频道名', shell.topbar.length > 0, shell.topbar)

// ② 图标轨切视图:多会话(第 7 位)→ SessionManageView 挂载
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.rail-views .rail-btn')]
  btns[6]?.click()
})
await sleep(1500)
const sessView = await page.evaluate(() => document.body.innerText.includes('多会话') || !!document.querySelector('.sm-wrap'))
check('轨道切到多会话视图', sessView)

// ③ 侧栏会话分组:点击会话行 → 保持/进入多会话视图
const miniPick = await page.evaluate(() => {
  const row = document.querySelector('.mini-row')
  if (!row) return 'no-row'
  row.click()
  return 'picked'
})
await sleep(1200)
check('侧栏会话分组可点', miniPick === 'picked', String(miniPick))

// ④ 侧栏频道切换:点第二个频道 → 标题条更新
const switchCh = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.channel-item')]
  if (rows.length < 2) return 'not-enough'
  rows[1].click()
  return 'clicked'
})
await sleep(1500)
const topAfter = await page.evaluate(() => document.querySelector('.chan-title')?.textContent?.trim() ?? '')
check('侧栏切换频道 → 标题条跟随', switchCh === 'clicked' && topAfter.length > 0, `after=${topAfter}`)

// ⑤ Composer 发送(任务模式 mock lead):POST /tasks 200 或 409 查重守卫
// 注意:sessions 视图刻意隐藏全局任务 composer(自带 session composer)——先切回对话视图。
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.channel-item')]
  rows[0]?.click()
})
await sleep(1200)
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.rail-views .rail-btn')]
  btns[0]?.click()
})
await sleep(1500)
let postStatus = 0, dupCode = false
page.on('response', async (r) => {
  if (!(r.request().method() === 'POST' && r.url().includes('/tasks'))) return
  postStatus = r.status()
  try {
    const j = await r.json()
    if (j.code === 'TASK_DUPLICATE') dupCode = true
  }
  catch { /* ignore */ }
})
const typed = await page.evaluate(() => {
  const ta = document.querySelector('.composer textarea')
  if (!ta) return 'no-input'
  const st = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  st.call(ta, `控制台交互冒烟 ${Date.now() % 100000}`)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})
if (typed === 'typed') {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /发送/.test(b.title ?? ''))
    btn ? btn.click() : document.querySelector('.composer textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await sleep(4000)
  check('Composer 发送(200 创建或 409 查重)', postStatus === 200 || dupCode, `status=${postStatus} dup=${dupCode}`)
}
else check('Composer 输入', false, String(typed))

check('全程无未捕获页面异常', errors.length === 0, errors.join(' | ').slice(0, 300))

await page.close()
await browser.close()
console.log(`\n=== 控制台交互冒烟 pass=${passed} fail=${failed} ===`)
process.exit(failed > 0 ? 1 : 0)
