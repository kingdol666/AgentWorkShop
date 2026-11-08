// 前后端交互实机演示:登录 → Channel 视图切换 → 发言持久化 → Project tab 切换
// 用法: node scripts/_audit/frontend-interaction-demo.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:4001'
const OUT = 'docs/audit/evidence/2026-11-08-full-acceptance/ui'
mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: !!ok, detail: String(detail).slice(0, 500) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${detail}`}`)
}
const WS = '90466b5c-043f-499e-b815-2072ab22d8db'
const CH = '0d80ae9f-2796-4429-afba-9b0614911966'
const PRJ = 'be5fbcb1-a988-4bbb-aac5-c28387f3a77a'

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
})
const token = (await login.json()).data.token
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.5 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))

async function go(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 60000, polling: 200 })
  await sleep(4500)
}
const text = () => page.evaluate(() => document.body.innerText)
const clickByLabel = async label => page.evaluate((l) => {
  const el = [...document.querySelectorAll('[title],button')].find(x => (x.getAttribute('title') === l) || ((x.textContent || '').trim() === l))
  if (!el) return false
  el.click()
  return true
}, label)

// 1) Channel 对话视图
await go(`/workshop/w/${WS}?channel=${CH}`)
step('U1', 'Channel 控制台加载 + 群聊可见', (await text()).includes('数据分析频道') && (await page.$('.composer-input')) !== null, (await text()).slice(0, 60))
await page.screenshot({ path: `${OUT}/u1-channel-chat.png` })

// 2) 视图切换(顶栏/轨道按钮按文案点击)
for (const [label, file, id] of [['任务板', 'u2-task-board.png', 'U2'], ['多会话', 'u3-sessions.png', 'U3'], ['时间线', 'u4-timeline.png', 'U4']]) {
  const clicked = await clickByLabel(label)
  await sleep(2600)
  const body = await text()
  const ok = clicked && body.length > 100
  step(id, `切换视图:${label}`, ok, clicked ? body.slice(0, 40) : 'button not found')
  await page.screenshot({ path: `${OUT}/${file}` })
}

// 3) 发言 → 刷新后仍在(后端持久化)
await clickByLabel('对话')
await sleep(2200)
if (!(await page.$('.composer-input'))) { await go(`/workshop/w/${WS}?channel=${CH}`) }
const msg = `前端演示消息 ${Date.now()}`
await page.click('.composer-input')
await page.type('.composer-input', msg, { delay: 8 })
await page.keyboard.press('Enter')
await sleep(3500)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 60000, polling: 200 })
await sleep(5000)
step('U5', '发言后刷新仍存在(后端持久化)', (await text()).includes(msg), msg)
await page.screenshot({ path: `${OUT}/u5-chat-persist.png` })
step('U6', '全程无 pageerror', errors.length === 0, errors.join(' | ').slice(0, 300))

// 4) Project tab 切换
await go(`/projects/${PRJ}`)
const tabNames = ['overview', 'plan', 'deliverables', 'approvals', 'events']
for (let i = 0; i < tabNames.length; i++) {
  const ok = await page.evaluate((k) => {
    const el = document.querySelector(`[data-testid="tab-${k}"]`)
    if (!el) return false
    el.click(); return true
  }, tabNames[i])
  await sleep(1200)
  const body = await text()
  step(`U7-${tabNames[i]}`, `Project tab:${tabNames[i]}`, ok && body.length > 200, body.slice(0, 40))
  if (i === 0) await page.screenshot({ path: `${OUT}/u7-project-overview.png` })
  if (tabNames[i] === 'approvals') await page.screenshot({ path: `${OUT}/u8-project-approvals.png` })
}

step('U9', 'Project 左侧 testid 齐备', await page.evaluate(() => ['project-tabs', 'project-leader-chat', 'tab-overview', 'tab-plan', 'tab-deliverables', 'tab-approvals', 'tab-events'].every(k => document.querySelector(`[data-testid="${k}"]`))), 'tab-*')

writeFileSync(`${OUT}/ui-results.json`, JSON.stringify({ at: new Date().toISOString(), pass: results.filter(r => r.pass).length, total: results.length, results }, null, 2))
console.log(`\n${results.filter(r => r.pass).length}/${results.length} UI assertions passed`)
await browser.close()
process.exit(results.every(r => r.pass) ? 0 : 1)
