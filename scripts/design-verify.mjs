/**
 * 设计重设计验证 — taste-skill 规范下的截图矩阵
 * 亮/暗两模式 × (首页 / monitor / workshop 登录页 / harness 控制台)
 * 产出 .design-verify/*.png 供人工复核。
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
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` })
  console.log(`  shot: ${name}.png`)
}

async function toggleDark(page) {
  // 头部主题切换按钮(moon/sun 图标按钮)
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('header button, .app-header button')]
    const theme = btns.find(b => b.querySelector('.i-tabler-moon-stars, .i-tabler-sun-high'))
    if (theme) {
      theme.click()
      return true
    }
    return false
  })
  await sleep(600)
  return clicked
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  // 注册专用验证账号 + mock 团队(lead + 2 worker,流式演示开启)
  const email = `design-verify-${Date.now().toString(36)}@test.local`
  const password = 'Passw0rd!123'
  const reg = await api('POST', '/api/users/register', { body: { name: `dv-${Date.now().toString(36)}`, email, password } })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 160)}`)

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'design-review',
      scenarioPrompt: '设计评审通道:验证 harness 渲染链路的事件流呈现',
      leadAgent: { name: 'review-lead', harness: 'mock', config: { delayMs: 200 } },
    },
    token,
  })
  const channelId = ch.data?.channelId
  if (!channelId) throw new Error(`channel 创建失败: ${JSON.stringify(ch).slice(0, 160)}`)
  for (const w of [
    { name: 'frontend-dev', harness: 'mock', role: 'worker', config: { delayMs: 260, streamDemo: true } },
    { name: 'ux-polish', harness: 'mock', role: 'worker', config: { delayMs: 320, streamDemo: true } },
  ]) {
    await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: w, token })
  }
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'design-verify-ws' }, token })
  if (ws.code === 0) await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${channelId}`, { token })
  console.log('  团队就绪 channel=' + channelId.slice(0, 8))

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)))

  console.log('=== 亮模式 ===')
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(2600)
  await shot(page, '01-home-light')

  await page.goto(`${BASE}/monitor`, { waitUntil: 'domcontentloaded' })
  await sleep(2200)
  await shot(page, '02-monitor-light')

  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2200)
  await shot(page, '03-workshop-login-light')

  // 登录 → harness 控制台(有 workspace → 控制台入口按钮)
  const emailInput = await page.$('input[type="email"]')
  if (emailInput) {
    await emailInput.type(email, { delay: 6 })
    const pwd = await page.$('input[type="password"]')
    await pwd.type(password, { delay: 6 })
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.replace(/\s/g, '') === '登录') {
        await b.click()
        break
      }
    }
    await sleep(3200)
  }
  if (!page.url().includes('/workshop/w/')) {
    await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
    await sleep(2200)
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        await sleep(3000)
        break
      }
    }
  }
  console.log('  harness url:', page.url().slice(-48))
  await sleep(3000)
  await shot(page, '04-harness-light')

  // 通过 Composer 提交一条任务(驱动事件流入时间线)
  const typed = await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '验证渲染链路\n请检查时间线事件块渲染')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  if (typed) {
    await sleep(300)
    const sent = await page.evaluate(() => {
      const ta = document.querySelector('.composer textarea')
      if (!ta) return false
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      return true
    })
    console.log('  task submitted:', sent)
    await sleep(3500)
    await shot(page, '05-harness-streaming-light')
    await sleep(6500)
    await shot(page, '06-harness-events-light')
  }

  console.log('=== 暗模式 ===')
  if (await toggleDark(page)) {
    await sleep(800)
    await shot(page, '07-harness-dark')
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await sleep(2600)
    await shot(page, '08-home-dark')
  }
  else {
    console.log('  [warn] 未找到主题切换按钮')
  }

  await browser.close()
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
