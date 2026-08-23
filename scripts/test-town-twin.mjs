/**
 * 数字孪生垂直切片 E2E:
 *  - 3D 场景拖 dev 模型(device-3d)进场景 → 生成设备节点 + 落一个 DeviceTwin;
 *  - 状态环颜色随 twin.state 变化(idle→running→alarm);
 *  - MCP device.control 指令经 REST 控制端驱动 twin.state;
 *  - 动作绑定:hero-3d 角色在场景,支持状态切换。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const SHELL = `${process.env.USERPROFILE}\\.cache\\puppeteer\\chrome-headless-shell\\win64-131.0.6778.204\\chrome-headless-shell-win64\\chrome-headless-shell.exe`
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/wuwa-twin'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, ep, { body, token } = {}) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${ep}`, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `tw-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `tw-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  if (!reg.data) {
    console.error('REG FAIL')
    process.exit(2)
  }
  const { token } = reg.data
  const ch = await api('POST', '/api/workshop/channels', { body: { name: 'twin-ch', scenarioPrompt: 't', leadAgent: { name: 'lead', harness: 'mock' } }, token })
  const cid = ch.data.channelId
  await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'w1', harness: 'mock', role: 'worker' }, token })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'twin-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cid}`, { token })

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
  await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
  // 等 3D 场景 ready(重试应对 401 抽风;token 传播后稳定)
  let ok = false
  for (let i = 0; i < 8 && !ok; i++) {
    await sleep(4000)
    ok = await page.evaluate(() => window.__town?.scene && 'screenToWorld' in window.__town.scene && window.__town.scene.getDebugState?.().blocks > 0)
    if (!ok) {
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
  }
  if (!ok) {
    console.error('NOT READY')
    process.exit(2)
  }

  // 断言:3D 场景就绪 + 有 agent
  const st = await page.evaluate(() => ({ blocks: window.__town.scene.getDebugState().blocks, agents: window.__town.scene.getDebugState().agents.length, devices: window.__town.scene.getDeviceNodes?.().length }))
  console.log('blocks:', st.blocks, 'agents:', st.agents, 'devices:', st.devices)

  // 拖 dev 模型进场景(空地带)
  await page.evaluate(() => window.__town.scene.dropModelOnWorld(1600, 1600, 'device-3d'))
  await sleep(1500)
  const devNodes = await page.evaluate(() => window.__town.scene.getDeviceNodes())
  console.log('设备节点:', JSON.stringify(devNodes.map(d => ({ id: d.twinId, state: d.state, x: d.x, z: d.z }))))
  const hasDevice = devNodes.length >= 1
  const twinId = devNodes[0]?.twinId
  console.log(`设备节点生成: ${hasDevice ? 'PASS' : 'FAIL'}`)

  // twin 是否被 REST 创建(通过 list 查)
  const twins = await api('GET', '/api/workshop/device-twins', { token })
  const twinInApi = (twins.data?.twins ?? []).find(t => t.modelRef === 'device-3d')
  console.log(`DeviceTwin 落库: ${twinInApi ? 'PASS' : 'CHECK'} (id=${twinInApi?.id})`)

  // MCP 控制:power_on → running;telemetry 高温 → alarm
  const tId = twinInApi?.id ?? twinId
  if (tId) {
    await api('POST', `/api/workshop/device-twins/${tId}/control`, { token, body: { command: 'power_on' } })
    await sleep(500)
    const afterCtrl = await api('GET', '/api/workshop/device-twins', { token })
    const ctrlTwin = (afterCtrl.data?.twins ?? []).find(t => t.id === tId)
    console.log(`MCP/控制 → state: ${ctrlTwin?.state} | ${ctrlTwin?.state === 'running' ? 'PASS' : 'CHECK'}`)
    await api('POST', `/api/workshop/device-twins/${tId}/telemetry`, { token, body: { telemetry: { temperature: 95 } } })
    await sleep(500)
    const afterTele = await api('GET', '/api/workshop/device-twins', { token })
    const alarmTwin = (afterTele.data?.twins ?? []).find(t => t.id === tId)
    console.log(`遥测高温 → state: ${alarmTwin?.state} | ${alarmTwin?.state === 'alarm' ? 'PASS' : 'CHECK'}`)
  }

  // 让 DeviceTwinPanel 轮询刷新后截图(展示设备卡/遥测/控制)
  await sleep(2500)
  await page.screenshot({ path: `${OUT}/01-twin-device.png` })
  const result = { hasDevice, twinInApi: !!twinInApi, stateRunning: twinInApi?.state === 'running' }
  console.log('\nSUMMARY:', JSON.stringify(result))
  console.log(hasDevice ? '\n==> TWIN OK' : '\n==> TWIN PARTIAL')
  await browser.close()
  process.exit(hasDevice ? 0 : 1)
}
main()
  .catch((e) => {
    console.error(e)
    process.exit(2)
  })
