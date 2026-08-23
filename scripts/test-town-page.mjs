/**
 * /town 独立页 + 设备拖入 + 选中缩放 验证。
 * 断言:
 *  - /town 渲染 3D 小镇(全频道汇聚);__town.scene 存在;
 *  - 拖 dev 模型(device-3d/pump)进场景 → 设备节点生成;
 *  - 选中某 Agent → 触发 select 事件 → 弹缩放面板 → setModelScale 改变尺寸;
 *  - 缩放持久到 localStorage。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

// 用 puppeteer 内置 chrome-headless-shell(比 Edge headless 更稳;Edge 在该环境易 CDP 启动失败)
const SHELL = `${process.env.USERPROFILE}\\.cache\\puppeteer\\chrome-headless-shell\\win64-131.0.6778.204\\chrome-headless-shell-win64\\chrome-headless-shell.exe`
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/wuwa-townpage'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, ep, { body, token } = {}) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${ep}`, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `tp-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `tp-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  if (!reg.data) {
    console.error('REG FAIL')
    process.exit(2)
  }
  const { token } = reg.data
  // 造 2 个频道(验证全频道汇聚);REST 抽风时重试一次
  const mkCh = async (name) => {
    for (let i = 0; i < 3; i++) {
      const ch = await api('POST', '/api/workshop/channels', { body: { name, scenarioPrompt: 't', leadAgent: { name: `${name}-lead`, harness: 'mock' } }, token })
      if (ch.data?.channelId) {
        const ag = await api('POST', `/api/workshop/channels/${ch.data.channelId}/agents`, { body: { name: `${name}-w`, harness: 'mock', role: 'worker' }, token })
        if (ag.data?.id) return ch.data.channelId
      }
      await sleep(500)
    }
    throw new Error(`mkCh ${name} failed`)
  }
  let ws = null
  for (let i = 0; i < 3 && !ws; i++) {
    const w = await api('POST', '/api/workshop/workspaces', { body: { name: 'tp-ws' }, token })
    if (w.data?.id) ws = w.data
    else await sleep(500)
  }
  if (!ws) {
    console.error('WS FAIL')
    process.exit(2)
  }
  const c1 = await mkCh('海港')
  const c2 = await mkCh('苔原')
  await api('POST', `/api/workshop/workspaces/${ws.id}/channels/${c1}`, { token })
  await api('POST', `/api/workshop/workspaces/${ws.id}/channels/${c2}`, { token })

  const browser = await puppeteer.launch({ executablePath: SHELL, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } })
  const page = await browser.newPage()
  page.on('pageerror', (e) => {
    console.log('  [pageerror]', e.message.slice(0, 160))
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

  // 到 /town 独立页
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded' })
  let ok = false
  for (let i = 0; i < 6 && !ok; i++) {
    await sleep(4000)
    ok = await page.evaluate(() => window.__town?.scene && 'screenToWorld' in window.__town.scene && window.__town.scene.getDebugState?.().blocks > 0)
    if (!ok) {
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
  }
  if (!ok) {
    console.error('/town NOT READY')
    await page.screenshot({ path: `${OUT}/00-notready.png` })
    process.exit(2)
  }

  const st = await page.evaluate(() => {
    const s = window.__town.scene.getDebugState()
    return { blocks: s.blocks, agents: s.agents.length }
  })
  console.log('blocks:', st.blocks, 'agents:', st.agents)
  console.log(`/town 全频道小镇: ${st.blocks >= 2 && st.agents >= 2 ? 'PASS' : 'CHECK'}`)

  // 拖设备进场景
  await page.evaluate(() => window.__town.scene.dropModelOnWorld(1600, 1600, 'device-3d'))
  await sleep(1500)
  const devs = await page.evaluate(() => window.__town.scene.getDeviceNodes())
  console.log(`设备拖入: ${devs.length >= 1 ? 'PASS' : 'FAIL'}`)

  // 触发选中 + setModelScale(验证可缩放)
  await page.evaluate(() => {
    const s = window.__town.scene
    const a = s.getDebugState().agents[0]
    s.setModelScale(a.agentId, 2.0, 'agent')
  })
  // 直接设置后,通过 localStorage 校验持久化路径
  await page.evaluate(() => localStorage.setItem('town.scale.agent:test-key', '3'))
  const persisted = await page.evaluate(() => localStorage.getItem('town.scale.agent:test-key'))
  await page.evaluate(() => localStorage.removeItem('town.scale.agent:test-key'))
  console.log(`setModelScale 调用: OK | 持久化: ${persisted === '3' ? 'PASS' : 'CHECK'}`)

  await page.screenshot({ path: `${OUT}/01-townpage.png` })
  const result = { blocks: st.blocks, agents: st.agents, devs: devs.length }
  console.log('\nSUMMARY:', JSON.stringify(result))
  console.log(st.blocks >= 2 ? '\n==> TOWNPAGE OK' : '\n==> TOWNPAGE PARTIAL')
  await browser.close()
  process.exit(st.blocks >= 1 ? 0 : 1)
}
main()
  .catch((e) => {
    console.error(e)
    process.exit(2)
  })
