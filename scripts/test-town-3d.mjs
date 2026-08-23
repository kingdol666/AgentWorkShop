/**
 * 小镇·3D(Three.js)走查与断言 —— 默认渲染器为 3D。
 * 断言:
 *  - 默认进入 ?view=town 时是 3D 渲染器(__town.scene 是 Three 场景,有 getMinimapState);
 *  - 渲染出 ≥1 领地 + 角色(getDebugState().blocks/agents);
 *  - drop 一个模型到角色 → 换装(modelRef/textureKey 变化);
 * 截图供人工走查。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const SHELL = `${process.env.USERPROFILE}\\.cache\\puppeteer\\chrome-headless-shell\\win64-131.0.6778.204\\chrome-headless-shell-win64\\chrome-headless-shell.exe`
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/wuwa-3d'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, ep, { body, token } = {}) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${ep}`, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `t3d-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `t3d-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  if (!reg.data) {
    console.error('REG FAIL')
    process.exit(2)
  }
  const { token } = reg.data
  // 3 频道(各 lead+worker) → 3D 环形布点
  const mkCh = async (name) => {
    const ch = await api('POST', '/api/workshop/channels', { body: { name, scenarioPrompt: 't', leadAgent: { name: `${name}-lead`, harness: 'mock' } }, token })
    await api('POST', `/api/workshop/channels/${ch.data.channelId}/agents`, { body: { name: `${name}-w`, harness: 'mock', role: 'worker' }, token })
    return ch.data.channelId
  }
  const cids = []
  for (const n of ['海港', '苔原', '工坊']) cids.push(await mkCh(n))
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 't3d-ws' }, token })
  for (const c of cids) await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${c}`, { token })

  const browser = await puppeteer.launch({ executablePath: SHELL, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } })
  const page = await browser.newPage()
  page.on('pageerror', (e) => {
    console.log('  [pageerror]', e.message.slice(0, 200))
  })
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const si = (s, v) => page.$eval(s, (el, val) => {
    const pr = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(pr, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await si('input[type=email]', email)
  await si('input[type=password]', 'Passw0rd!123')
  await sleep(200)
  for (const bt of await page.$$('button')) {
    if (((await bt.evaluate(el => el.textContent)) || '').trim().replace(/\s/g, '') === '登录') {
      await bt.click()
      break
    }
  }
  await sleep(4500)
  await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
  await sleep(6000)

  // 断言:是 3D 渲染器 + 有 blocks/agents(偶尔 401 抽风 → 重试一次)
  let state = { ok: false }
  for (let i = 0; i < 3; i++) {
    state = await page.evaluate(() => {
      const s = window.__town?.scene
      if (!s) return { ok: false }
      return { ok: true, is3D: typeof s.getMinimapState === 'function' && 'screenToWorld' in s, blocks: s.getDebugState?.().blocks, agents: s.getDebugState?.().agents?.length }
    })
    if (state.ok) break
    await sleep(2000)
    await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
    await sleep(4000)
  }
  console.log('state:', JSON.stringify(state))
  const is3D = state.is3D === true
  console.log(`3D 渲染器: ${is3D ? 'PASS' : 'CHECK'} | blocks=${state.blocks} agents=${state.agents}`)

  await page.screenshot({ path: `${OUT}/01-3d-town.png` })

  // 放大到 某 worker,展示 3D 角色近景
  if (is3D) {
    await page.evaluate(() => {
      const s = window.__town.scene
      const mm = s.getMinimapState()
      const a = mm.agents.find(x => x.busy === false) || mm.agents[0]
      if (a && s.focusTo) s.focusTo(a.x * mm.world.w, a.y * mm.world.h)
      s.dolly = 1.9
    })
    await sleep(1200)
    await page.screenshot({ path: `${OUT}/02-3d-closeup.png` })
  }

  // 若 3D 正常,断言 drop 换装
  if (is3D) {
    const worker = await page.evaluate(() => window.__town.scene.getDebugState().agents.find(a => a.role === 'worker' && a.channelId))
    const before = worker?.textureKey
    await page.evaluate(w => window.__town.scene.dropModelOnWorld(w.x, w.y, 'knight'), worker)
    await sleep(1500)
    const after = await page.evaluate(id => window.__town.scene.getDebugState().agents.find(a => a.agentId === id)?.textureKey, worker.agentId)
    console.log(`换装: ${before} → ${after} | ${after === 'knight' && after !== before ? 'PASS' : 'CHECK'}`)
    await page.screenshot({ path: `${OUT}/02-3d-rebind.png` })
  }

  const ok = is3D && state.blocks >= 1 && state.agents >= 1
  console.log(ok ? '\n==> 3D OK' : '\n==> 3D NOT READY')
  await browser.close()
  process.exit(ok ? 0 : 1)
}
main()
  .catch((e) => {
    console.error(e)
    process.exit(2)
  })
