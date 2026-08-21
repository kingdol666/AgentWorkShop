/**
 * 模板隔离功能前端截图验证:普通用户(模板库/Channel 模板/会话栏挂载模板)+ admin(monitor 归属视图/用户管理)。
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:3001'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = '.design-verify'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

async function login(page, email, password) {
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2000)
  const emailInput = await page.$('input[type="email"]')
  if (!emailInput) throw new Error('未找到登录表单')
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
  await sleep(3200)
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  // 普通用户
  const email = `ui-verify-${Date.now().toString(36)}@test.local`
  await api('POST', '/api/users/register', { body: { name: `uiverify-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))
  await login(page, email, 'Passw0rd!123')

  await page.goto(`${BASE}/workshop/agents`, { waitUntil: 'domcontentloaded' })
  await sleep(2600)
  await page.screenshot({ path: `${SHOT_DIR}/tpl-01-agents-user.png` })
  console.log('shot: tpl-01-agents-user.png')

  await page.goto(`${BASE}/workshop/channel-templates`, { waitUntil: 'domcontentloaded' })
  await sleep(2600)
  await page.screenshot({ path: `${SHOT_DIR}/tpl-02-channel-templates.png` })
  console.log('shot: tpl-02-channel-templates.png')

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
  await sleep(2200)
  await page.screenshot({ path: `${SHOT_DIR}/tpl-03-harness-session-list.png` })
  console.log('shot: tpl-03-harness-session-list.png')

  // admin 视图
  await page.evaluate(() => {
    localStorage.clear()
  })
  await page.reload()
  await sleep(1500)
  await login(page, 'zhangwei@awshop.io', 'Awshop@123')

  await page.goto(`${BASE}/monitor`, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  await page.screenshot({ path: `${SHOT_DIR}/tpl-04-monitor-admin.png` })
  console.log('shot: tpl-04-monitor-admin.png')

  await page.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded' })
  await sleep(2600)
  await page.screenshot({ path: `${SHOT_DIR}/tpl-05-users-admin.png` })
  console.log('shot: tpl-05-users-admin.png')

  await browser.close()
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
