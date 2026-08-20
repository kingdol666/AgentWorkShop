/**
 * 任务抽屉四 tab 独立切换验证(puppeteer-core 驱动 Edge headless):
 *  - API 侧:注册用户 → 建 workspace 挂 channel(mock lead+worker)→ 提交任务等待完成
 *  - UI 侧:cookie token 注入登录 → 进入控制台 → 命令面板切任务板 → 点卡片开抽屉
 *  - 断言:时间线/交付物/子任务/原始内容 四 tab 依次点击后内容独占渲染,不粘连
 * 运行:node scripts/test-task-drawer.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

let passed = 0, failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? passed += 1 : failures += 1
}

async function main() {
  mkdirSync('data/shots', { recursive: true })
  // ===== API 准备 =====
  const email = `drawer-ui-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `drawer-ui-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  const token = reg.data?.token ?? reg.token
  if (!token) throw new Error('注册失败: ' + JSON.stringify(reg).slice(0, 160))

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: `drawer-ui-${Date.now().toString(36)}`,
      leadAgent: { name: 'ui-lead', harness: 'mock' },
    },
    token,
  })
  if (ch.code !== 0) throw new Error('channel 创建失败: ' + JSON.stringify(ch).slice(0, 160))
  const channelId = ch.data.channelId
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { name: 'ui-worker', harness: 'mock', role: 'worker' }, token })
  // 建 workspace 并挂载 channel(进入控制台按钮在 workspace 卡片上)
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'drawer-ui-ws' }, token })
  const wsId = ws.data?.id ?? ws.data?.workspaceId
  if (!wsId) throw new Error('workspace 创建失败: ' + JSON.stringify(ws).slice(0, 160))
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`, { token })

  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: 'drawer-tab-check', description: 'mock simple task for drawer tabs' },
    token,
  })
  const parentId = task.data?.id
  if (!parentId) throw new Error('任务提交失败: ' + JSON.stringify(task).slice(0, 160))

  // 等完成(mock 秒级)
  let state = ''
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const tasks = (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
    state = tasks.find(t => t.id === parentId)?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) break
  }
  check('mock 任务完成(带交付)', state === 'COMPLETED', `state=${state}`)

  // ===== UI 验证 =====
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,900'],
    defaultViewport: { width: 1500, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.setCookie({ name: 'token', value: token, url: BASE })

  // 进入控制台:若停在登录门则用表单登录(邮箱/密码占位符定位)
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  let entered = false
  for (let attempt = 0; attempt < 2 && !entered; attempt++) {
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        entered = true
        break
      }
    }
    if (!entered) {
      const emailInput = await page.$('input[type="email"]')
      if (!emailInput) break
      await emailInput.type(email, { delay: 10 })
      const pwdInput = await page.$('input[type="password"]')
      await pwdInput.type('Passw0rd!123', { delay: 10 })
      for (const b of await page.$$('button')) {
        const txt = (await b.evaluate(el => el.textContent) || '').trim()
        if (txt.replace(/\s/g, '') === '登录') {
          await b.click()
          break
        }
      }
      await sleep(2000)
    }
  }
  check('进入控制台', entered)
  await sleep(2200)
  console.log('  URL:', page.url())

  // 等任务板可通过命令面板切换:Ctrl+K → 任务板 → Enter
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await sleep(600)
  await page.keyboard.type('任务板')
  await sleep(300)
  await page.keyboard.press('Enter')
  await sleep(1200)
  const cardCount = await page.$$eval('.card', els => els.length)
  check('任务板视图切换(⌘K)且卡片渲染', cardCount >= 1, `cards=${cardCount}`)

  // 点含 drawer-tab-check 的卡片开抽屉
  let drawerOpened = false
  for (const c of await page.$$('.card')) {
    const txt = await c.evaluate(el => el.textContent)
    if (txt.includes('drawer-tab-check')) {
      await c.click()
      drawerOpened = true
      break
    }
  }
  check('点击卡片打开任务抽屉', drawerOpened)
  await sleep(1800)

  const drawerVisible = await page.$$eval('.ant-drawer-content', els => els.some(e => e.offsetParent !== null))
  check('抽屉可见', drawerVisible)

  // ===== 四 tab 依次点击并断言内容独占渲染 =====
  const clickTab = async (label) => {
    const tabs = await page.$$('.ant-drawer .ant-tabs-tab')
    for (const t of tabs) {
      const txt = (await t.evaluate(el => el.textContent) || '').trim()
      if (txt.startsWith(label)) {
        await t.click()
        return true
      }
    }
    return false
  }
  const activePaneText = async () => {
    const panes = await page.$$('.ant-drawer .ant-tabs-tabpane-active')
    if (panes.length === 0) return ''
    return (await panes[0].evaluate(el => el.textContent) || '').slice(0, 400)
  }

  // tab1 状态时间线(默认)
  let text = await activePaneText()
  check('tab[状态时间线] 默认渲染', text.includes('暂无事件') || /\d{2}:\d{2}:\d{2}/.test(text), text.slice(0, 60))

  // tab2 交付物
  check('点击 tab[交付物]', await clickTab('交付物'))
  await sleep(500)
  text = await activePaneText()
  check('tab[交付物] 内容渲染(artifact 卡)', text.includes('deliverable') || text.includes('mock 成果') || text.includes('(无)'), text.slice(0, 60))
  check('tab[交付物] 不含子任务/原始 JSON 粘连', !text.includes('"artifactId"'), '')

  // tab3 子任务
  check('点击 tab[子任务]', await clickTab('子任务'))
  await sleep(500)
  text = await activePaneText()
  check('tab[子任务] 内容渲染', text.includes('(无子任务)') || text.includes('drawer-tab-check') || /COMPLETED|WORKING/.test(text), text.slice(0, 60))
  check('tab[子任务] 不含交付 JSON', !text.includes('"artifactId"'), '')

  // tab4 原始内容
  check('点击 tab[原始内容]', await clickTab('原始内容'))
  await sleep(500)
  text = await activePaneText()
  check('tab[原始内容] JSON 渲染', text.includes('"artifactId"') || text.includes('parts'), text.slice(0, 60))

  // 回切 tab2 验证可重复切换
  check('回切 tab[交付物]', await clickTab('交付物'))
  await sleep(500)
  text = await activePaneText()
  check('回切后交付物内容恢复', !text.includes('"artifactId"') || text.includes('deliverable'), text.slice(0, 50))

  await page.screenshot({ path: 'data/shots/drawer-tabs-final.png' }).catch(() => {})
  await browser.close()

  // 清理
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('异常:', err.message)
  process.exit(1)
})
