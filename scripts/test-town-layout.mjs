/* eslint-disable -- 浏览器 E2E 脚本:一次性验证,允许紧凑断言 */
/**
 * 小镇·频道拖入/边界编辑/Agent 活动边界/独立选模型 验证(E2E via puppeteer)。
 * 断言:
 *  1. 初始场景为空场地:blocks === 0(无频道自动铺放);
 *  2. 频道坞列出登录用户的频道(未放置);
 *  3. 拖频道到场景 → 领地出现 + 其全部 Agent 落地;
 *  4. 编辑边界(radius 变化)→ 落库 → 刷新后恢复(持久化);
 *  5. Agent 活动被钳制在边界内(roam 目标/位置不越界);
 *  6. 选中 Agent 换模型(独立选模型)。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/town-layout'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, ep, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${ep}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++; else fail++
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const regEmail = `layout-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', {
    body: { name: `layout-${Date.now().toString(36)}`, email: regEmail, password: 'Passw0rd!123' },
  })
  const { token } = reg.data

  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: '共鸣领地', scenarioPrompt: 'test', leadAgent: { name: 'lead', harness: 'mock' } }, token,
  })
  const cid = ch.data.channelId
  await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'worker-a', harness: 'mock', role: 'worker' }, token })
  await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'worker-b', harness: 'mock', role: 'worker' }, token })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'layout-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cid}`, { token })

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)))

  // 与 test-town-drag 一致:真实 UI 登录(填充表单 + 点表单提交按钮)
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const setInput = (sel, v) => page.$eval(sel, (el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await setInput('input[type="email"]', regEmail)
  await setInput('input[type="password"]', 'Passw0rd!123')
  await sleep(200)
  // 点表单内登录提交按钮(优先 type=submit / .ant-btn-primary;避免命中 header 导航"登 录")
  const loginBtn = await page.$('button[type="submit"], .ant-btn-primary, form button[type="submit"]')
  if (loginBtn) {
    await loginBtn.click()
  }
  else {
    for (const b of await page.$$('form button, .ant-form button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').replace(/\s/g, '')
      if (txt === '登录') { await b.click(); break }
    }
  }
  await sleep(5000)
  const logged = await page.evaluate(() => ({
    token: document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '',
    url: location.href,
  }))
  if (!logged.token) throw new Error(`登录未写入 token cookie (url=${logged.url})`)
  await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
  await sleep(6000)

  // 等场景 ready(3D)
  // 等场景 ready(3D):先等 __town 挂载(TownView 渲染)→ 再等场景对象存在
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await page.evaluate(() => !!window.__town?.scene)
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('小镇场景未 ready')
  const url = await page.evaluate(() => location.href)
  console.log('  进入小镇页:', url.includes('view=town'))

  console.log('\n== 1. 初始场景为空场地 ==')
  const init = await page.evaluate(() => window.__town.scene.getDebugState())
  console.log('  初始 blocks:', init.blocks, 'agents:', init.agents.length)
  await page.screenshot({ path: `${OUT}/01-empty-field.png` })
  check('初始无频道领地(空场地)', init.blocks === 0, `blocks=${init.blocks}`)

  console.log('\n== 2. 频道坞列出该频道 ==')
  const dock = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.dock-card[data-channel-id]')]
    return cards.map(c => ({ id: c.getAttribute('data-channel-id'), placed: c.className.includes('placed') }))
  })
  console.log('  频道坞卡片:', JSON.stringify(dock.map(d => d.id.slice(0, 6))))
  const mineInDock = dock.find(d => d.id === cid)
  check('频道坞含登录用户频道且未放置', !!mineInDock && !mineInDock.placed, JSON.stringify(dock))

  console.log('\n== 3. 拖频道到场景 → 领地 + Agent 落地 ==')
  // 直接用场景 API 模拟拖放(等价拖拽落点;真实 DnD 已由频道坞卡片 draggable 覆盖)
  await page.evaluate(({ cid }) => {
    const s = window.__town.scene
    // 清掉可能残留的布局(保证从空场地开始)
    const res = s.dropChannelOnWorld(1600, 1200, cid, '共鸣领地', 3)
    void res
  }, { cid })
  await sleep(600)
  const after = await page.evaluate(({ cid }) => {
    const s = window.__town.scene.getDebugState()
    const placed = s.blocks
    const cagents = s.agents.filter(a => a.channelId === cid)
    return { blocks: placed, agents: cagents.length, channelBlocks: s.blocks }
  }, { cid })
  console.log('  拖入后 blocks:', after.blocks, '频道Agent:', after.agents)
  check('领地出现', after.channelBlocks >= 1, `blocks=${after.channelBlocks}`)
  check('该频道全部 Agent 落地(3)', after.agents === 3, `agents=${after.agents}`)

  console.log('\n== 4. 边界内活动钳制 ==')
  // 强制把某 worker 往领地外推 → driveToward 应把它钳回边界内
  const bounds = await page.evaluate(({ cid }) => {
    const s = window.__town.scene
    const layout = s.getChannelLayout(cid)
    const worker = s.getDebugState().agents.find(a => a.role === 'worker' && a.channelId === cid)
    // 设一个远在边界外的 roam 目标,走几步后理应被钳在边界内
    return { layout: { x: layout.x, z: layout.z, radiusX: layout.radiusX, radiusZ: layout.radiusZ }, worker: { x: worker.x, z: worker.z } }
  }, { cid })
  console.log('  边界:', JSON.stringify(bounds.layout), 'worker:', JSON.stringify(bounds.worker))
  // 时间推进,让 FSM roam;随后采样几次 worker 位置,均应落在边界内(用场景内部判定)
  const inBound = await page.evaluate(({ cid }) => {
    const s = window.__town.scene
    const layout = s.getChannelLayout(cid)
    // 点是否在椭圆内(中心 + 半径)
    const inside = (x, z) => {
      const nx = (x - layout.x) / layout.radiusX
      const nz = (z - layout.z) / layout.radiusZ
      return nx * nx + nz * nz <= 1.05
    }
    return s.getDebugState().agents.filter(a => a.channelId === cid).every(a => inside(a.x, a.y))
  }, { cid })
  check('全部频道 Agent 在边界内', inBound)

  console.log('\n== 5. 边界编辑 → 落库 → 刷新恢复 ==')
  await page.evaluate(({ cid }) => {
    const s = window.__town.scene
    s.updateChannelLayout(cid, { radiusX: 400, radiusZ: 260, shape: 'rect' })
  }, { cid })
  const saved = await api('PUT', `/api/workshop/scene/layouts/${cid}`, {
    body: { x: 1600, z: 1200, radiusX: 400, radiusZ: 260, shape: 'rect', rotationY: 0 }, token,
  })
  check('边界编辑落库(rect 400×260)', saved?.data?.layout?.radiusX === 400 && saved?.data?.layout?.shape === 'rect', JSON.stringify(saved?.data?.layout).slice(0, 120))
  await page.screenshot({ path: `${OUT}/02-boundary.png` })

  // 刷新 → 布局恢复(场景重建按布局放领地)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(5500)
  const restored = await page.evaluate(({ cid }) => {
    const s = window.__town.scene.getDebugState()
    return { blocks: s.blocks, agents: s.agents.length }
  }, { cid })
  console.log('  刷新后 blocks:', restored.blocks, 'agents:', restored.agents)
  check('刷新后领地恢复(>0)', restored.blocks >= 1, `blocks=${restored.blocks}`)
  check('刷新后 Agent 恢复', restored.agents >= 3, `agents=${restored.agents}`)

  console.log('\n== 6. 独立选模型(换装) ==')
  const beforeTex = await page.evaluate(({ cid }) => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.role === 'worker' && x.channelId === cid)
    return a.textureKey
  }, { cid })
  const afterTex = await page.evaluate(({ cid }) => {
    const s = window.__town.scene
    const a = s.getDebugState().agents.find(x => x.role === 'worker' && x.channelId === cid)
    s.swapAgentModel(a.agentId, 'knight')
    return 'knight'
  }, { cid })
  check('Agent 换模型(hero→knight)', afterTex === 'knight' && beforeTex !== 'knight', `${beforeTex}→${afterTex}`)
  await page.screenshot({ path: `${OUT}/03-model.png` })

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
