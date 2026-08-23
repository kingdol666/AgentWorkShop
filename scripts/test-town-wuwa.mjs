/**
 * 小镇·共鸣黄昏 改版验证(E2E via puppeteer):
 *  - 场景地图渲染(不再是白色方块);
 *  - 同一 Channel 的 Agent 共享同色共鸣灵光(同频道 auraColor 一致,跨频道不同);
 *  - 所有 Agent 可被手动拖动到地图任意位置(拖后 home 更新,draggable=true);
 *  - 头顶气泡/状态环仍驱动。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/wuwa-town'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, ep, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${ep}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `wu-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', {
    body: { name: `wu-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' },
  })
  const { token } = reg.data

  // 两个频道,各自 lead + 2 worker → 验证跨频道不同色、同频道同色
  const chA = await api('POST', '/api/workshop/channels', {
    body: { name: '共鸣海港', scenarioPrompt: 'test', leadAgent: { name: 'a-lead', harness: 'mock' } }, token,
  })
  await api('POST', `/api/workshop/channels/${chA.data.channelId}/agents`, {
    body: { name: 'a-w1', harness: 'mock', role: 'worker' }, token,
  })
  await api('POST', `/api/workshop/channels/${chA.data.channelId}/agents`, {
    body: { name: 'a-w2', harness: 'mock', role: 'worker' }, token,
  })
  const chB = await api('POST', '/api/workshop/channels', {
    body: { name: '苍山苔原', scenarioPrompt: 'test', leadAgent: { name: 'b-lead', harness: 'mock' } }, token,
  })
  await api('POST', `/api/workshop/channels/${chB.data.channelId}/agents`, {
    body: { name: 'b-w1', harness: 'mock', role: 'worker' }, token,
  })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'wu-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${chA.data.channelId}`, { token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${chB.data.channelId}`, { token })

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const setInput = (sel, v) => page.$eval(sel, (el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await setInput('input[type="email"]', email)
  await setInput('input[type="password"]', 'Passw0rd!123')
  await sleep(200)
  for (const b of await page.$$('button')) {
    if ((await b.evaluate(el => el.textContent) || '').replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(4500)

  // 直接进入目标 workspace 的小镇视图(深链 ?view=town)
  const wsUrl = `${BASE}/workshop/w/${ws.data.id}?view=town`
  await page.goto(wsUrl, { waitUntil: 'domcontentloaded' })
  await sleep(5500)
  console.log('URL:', page.url())

  // 等待场景 ready
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await page.evaluate(() => window.__town?.scene && window.__town.scene.getDebugState?.()?.blocks > 0)
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('小镇场景未 ready')

  await page.screenshot({ path: `${OUT}/01-town-map.png` })

  // 断言 1:渲染态
  const state = await page.evaluate(() => window.__town.scene.getDebugState())
  console.log('blocks:', state.blocks, 'agents:', state.agents.length, 'player:', state.player)
  console.log('agents:', state.agents.map(a => `${a.name}(${a.role})@ch=${a.channelId.slice(0, 4)} aura=#${a.auraColor.toString(16)} drag=${a.draggable}`).join(' | '))

  // 断言 2:同频道发光同色、跨频道不同色
  const byCh = {}
  for (const a of state.agents) (byCh[a.channelId] ??= []).push(a.auraColor)
  const chIds = Object.keys(byCh)
  if (chIds.length < 2) throw new Error(`需要至少 2 个频道,实际 ${chIds.length}`)
  let sameWithin = true
  for (const id of chIds) {
    const colors = [...new Set(byCh[id])]
    if (colors.length !== 1) sameWithin = false
  }
  const diffAcross = new Set(chIds.map(id => byCh[id][0])).size === chIds.length
  console.log(`同频道同色: ${sameWithin ? 'PASS' : 'FAIL'} | 跨频道异色: ${diffAcross ? 'PASS' : 'FAIL'}`)

  // 断言 3:所有 agent 可拖动
  const allDraggable = state.agents.every(a => a.draggable)
  console.log(`全部可拖动: ${allDraggable ? 'PASS' : 'FAIL'}`)

  // 断言 4:手动拖动第 1 个 agent → sprite 位置变化 + home 更新
  const target = state.agents[0]
  // 世界坐标 → 页面坐标:cam.worldView(已含 zoom)映射到 canvas DOM 尺寸
  const tr = await page.evaluate(({ target }) => {
    const s = window.__town.scene
    const cam = s.cameras.main
    const cv = s.sys.game.canvas
    const rect = cv.getBoundingClientRect()
    const wv = cam.worldView
    const gsx = (target.x - wv.x) / wv.width * cam.width
    const gsy = (target.y - wv.y) / wv.height * cam.height
    const px = rect.left + gsx * (rect.width / cam.width)
    const py = rect.top + gsy * (rect.height / cam.height)
    return { px, py, rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height }, wv: { x: wv.x, y: wv.y, w: wv.width, h: wv.height }, zoom: cam.zoom, camW: cam.width, camH: cam.height }
  }, { target })
  console.log('DRAGINFO', JSON.stringify({ px: Math.round(tr.px), py: Math.round(tr.py), rect: tr.rect, wv: tr.wv, zoom: tr.zoom, camW: tr.camW, camH: tr.camH }))

  // 该 agent 拖动前位置
  const before = await page.evaluate((id) => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.agentId === id)
    return { x: a.x, y: a.y, homeX: a.homeX, homeY: a.homeY }
  }, target.agentId)
  console.log('before:', before)

  // 抓取:精灵可拖拽命中区为整帧(48x88, 中心为原点),在中心 ±20px 内小范围试抓直至 dragging=true
  const dx = 120, dy = 90
  const startCx = tr.px, startCy = tr.py
  let grabbed = false
  for (const ox of [0, 20, -20, 40, -40, 0]) {
    for (const oy of [0, -18, 18, -34, 34]) {
      if (startCy + oy < tr.rect.t || startCy + oy > tr.rect.t + tr.rect.h) continue
      await page.mouse.move(startCx + ox, startCy + oy)
      await page.mouse.down()
      await sleep(60)
      grabbed = await page.evaluate(id => window.__town.scene.agents.get(id)?.dragging === true, target.agentId)
      if (grabbed) break
      await page.mouse.up()
      await sleep(30)
    }
    if (grabbed) break
  }
  if (!grabbed) throw new Error('未抓取到 agent(拖动未激活)')
  console.log('抓取成功')

  await page.mouse.move(startCx + dx, startCy + dy, { steps: 14 })
  await sleep(250)
  await page.mouse.up()
  // 读取落点:home 应等于释放点(世界坐标);agent 随后恢复 roam,故仅比对 home 与 releasedPos
  const after = await page.evaluate(({ target, dx, dy, tr }) => {
    const s = window.__town.scene
    const a = s.getDebugState().agents.find(x => x.agentId === target)
    // 释放点世界坐标(从最终页面点反推)
    const wv = s.cameras.main.worldView
    const camW = s.cameras.main.width
    const gsx = (tr.px + dx - tr.rect.l) / (tr.rect.w / camW)
    const gsy = (tr.py + dy - tr.rect.t) / (tr.rect.h / s.cameras.main.height)
    const wx = wv.x + (gsx / camW) * wv.width
    const wy = wv.y + (gsy / s.cameras.main.height) * wv.height
    return { x: a.x, y: a.y, homeX: a.homeX, homeY: a.homeY, wx, wy }
  }, { target: target.agentId, dx, dy, tr })
  console.log('after :', after)
  const moved = Math.abs(after.x - after.wx) < 40 || Math.abs(after.x - before.x) > 5
  // home 应接近释放点世界坐标(120,90 页面位移 → 世界位移)
  const homeAtDrop = Math.abs(after.homeX - after.wx) < 60 && Math.abs(after.homeY - after.wy) < 60
  console.log(`拖动移动: ${moved ? 'PASS' : 'FAIL'} | 落点即新 home: ${homeAtDrop ? 'PASS' : 'FAIL'}`)

  await page.screenshot({ path: `${OUT}/02-dragged.png` })

  const summary = {
    sameWithin, diffAcross, allDraggable, moved, homeAtDrop,
    blocks: state.blocks, agents: state.agents.length,
  }
  console.log('\nSUMMARY:', JSON.stringify(summary))
  const allPass = sameWithin && diffAcross && allDraggable && moved && homeAtDrop
  console.log(allPass ? '\n==> ALL PASS' : '\n==> SOME FAIL')
  await browser.close()
  process.exit(allPass ? 0 : 1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(2)
  })
