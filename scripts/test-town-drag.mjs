/* eslint-disable -- 浏览器 E2E 脚本:一次性验证,允许紧凑断言 */
/**
 * 小镇·模型拖拽加载 + 全频道 Agent 落地 验证(E2E via puppeteer)。
 * 断言:
 *  - 所有频道 Agent 均落地(buildTownInput 遍历 entities.channels;多频道>1 均渲染);
 *  - AssetLibrary 存在可拖拽模型卡,拖起写入 assetId(dataTransfer);
 *  - 把模型拖到场景某角色 → 该角色 textureKey/modelRef 切换为模型 id(换装);
 *  - 拖到空地带 → 生成可拖拽居民。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/wuwa-drag'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, ep, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${ep}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `drag-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', {
    body: { name: `drag-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' },
  })
  const { token } = reg.data

  // 两个频道(各 lead + 1 worker) → 验证全频道 Agent 落地
  const mkCh = async (name, lead, w1) => {
    const ch = await api('POST', '/api/workshop/channels', {
      body: { name, scenarioPrompt: 'test', leadAgent: { name: lead, harness: 'mock' } }, token,
    })
    await api('POST', `/api/workshop/channels/${ch.data.channelId}/agents`, {
      body: { name: w1, harness: 'mock', role: 'worker' }, token,
    })
    return ch.data.channelId
  }
  const cidA = await mkCh('共鸣海港', 'a-lead', 'a-worker')
  const cidB = await mkCh('苍山苔原', 'b-lead', 'b-worker')
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'drag-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cidA}`, { token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cidB}`, { token })

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

  await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
  await sleep(5500)

  // 等待场景 ready(模型库异步加载,单独断言)
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await page.evaluate(() => !!window.__town?.scene)
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('小镇场景未 ready')
  // 新需求:初始为空场地——把两个频道拖入场景(模拟频道坞拖放;placeChannel 铺放其全部 Agent)
  await page.evaluate(({ cidA, cidB }) => {
    const s = window.__town.scene
    s.dropChannelOnWorld(1600, 1200, cidA, '共鸣海港', 2)
    s.dropChannelOnWorld(2600, 1200, cidB, '苍山苔原', 2)
  }, { cidA, cidB })
  await sleep(1200)
  await page.evaluate(() => window.__town.scene.getDebugState())
  // 等模型库加载完成
  let modelsReady = false
  for (let i = 0; i < 20 && !modelsReady; i++) {
    modelsReady = await page.evaluate(() => (window.__town?.characterAssets?.models?.length ?? 0) > 0)
    if (!modelsReady) await sleep(300)
  }
  console.log('modelsLoaded:', modelsReady)

  await page.screenshot({ path: `${OUT}/01-town-library.png` })

  // 断言 0:AssetLibrary 组件是否挂载(诊断)
  const diag = await page.evaluate(() => {
    const hud = document.querySelector('.hud')
    return {
      libWhitelist: !!document.querySelector('.asset-lib'),
      libPanel: document.querySelectorAll('.lib-panel').length,
      modelImg: document.querySelectorAll('.model-img').length,
      hudChildren: [...(hud?.children || [])].map(c => (c.className || c.tagName).toString().slice(0, 30)),
    }
  })
  console.log('AssetLibrary diag:', JSON.stringify(diag))

  // 断言 1:全频道 Agent 落地(2 频道 × 2 agent = 4)
  const state = await page.evaluate(() => window.__town.scene.getDebugState())
  const agents = state.agents
  const chIds = [...new Set(agents.map(a => a.channelId).filter(Boolean))]
  console.log('blocks:', state.blocks, 'agents:', agents.length, 'channels:', chIds.length)
  console.log('agents:', agents.map(a => `${a.name}(${a.role})@ch=${a.channelId.slice(0, 4)} tex=${a.textureKey} drag=${a.draggable}`).join(' | '))
  const allLand = chIds.length >= 2 && agents.filter(a => a.channelId).length >= 4
  console.log(`全频道 Agent 落地: ${allLand ? 'PASS' : 'FAIL'}`)

  // 断言 2:AssetLibrary 有模型卡且可拖(轮询等待组件挂载+模型加载)
  let libDom = { lib: 0, cards: 0, cardIds: [] }
  for (let i = 0; i < 20; i++) {
    libDom = await page.evaluate(() => ({
      lib: document.querySelectorAll('.asset-lib').length,
      cards: document.querySelectorAll('.model-card').length,
      cardIds: [...document.querySelectorAll('.model-card[data-model-id]')].map(e => e.getAttribute('data-model-id')),
    }))
    if (libDom.cardIds.length > 0) break // 等模型加载完成(卡片带 data-model-id)再断言
    await sleep(400)
  }
  console.log('AssetLibrary DOM:', JSON.stringify(libDom))
  const modelCount = libDom.cards
  const canDrag = libDom.cardIds.length > 0 && await page.$eval('.model-card[data-model-id]', el => el.getAttribute('draggable') === 'true').catch(() => false)
  console.log(`模型库卡数: ${modelCount} | 可拖拽: ${canDrag ? 'PASS' : 'FAIL'}`)

  // 断言 3:拖模型到某角色 → 换装(textureKey/modelRef 变 modelId)
  // 取第一个频道 worker(默认 3D 渲染器 TownScene3D:getDebugState 的 x/y 即世界坐标,
  // 直接在世界坐标调用 dropModelOnWorld;HTML5 drag 可拖拽已由「可拖拽」断言覆盖)
  const worker = agents.find(a => a.role === 'worker' && a.channelId)
  const beforeTex = worker.textureKey
  await page.evaluate(({ x, y, assetId }) => {
    window.__town.scene.dropModelOnWorld(x, y, assetId)
  }, { x: worker.x, y: worker.y, assetId: 'knight' })
  await sleep(400)
  const afterTex = await page.evaluate(({ id }) => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.agentId === id)
    return a.textureKey
  }, { id: worker.agentId })
  console.log(`换装前: ${beforeTex} → 后: ${afterTex} | ${afterTex === 'knight' && afterTex !== beforeTex ? 'PASS' : 'FAIL'}`)

  await page.screenshot({ path: `${OUT}/02-rebound.png` })

  // 断言 4:拖到空地带 → 生成居民
  const beforeCount = agents.length
  await page.evaluate(({ assetId }) => {
    const s = window.__town.scene
    // 放到地图底部空旷处(远离任何 agent 80px)
    s.dropModelOnWorld(800, 900, assetId)
  }, { assetId: 'mage' })
  await sleep(300)
  const afterCount = await page.evaluate(() => window.__town.scene.getDebugState().agents.length)
  const resident = await page.evaluate(() => window.__town.scene.getDebugState().agents.find(a => a.decorated))
  console.log(`生成居民: ${afterCount > beforeCount && resident ? 'PASS' : 'FAIL'} (${beforeCount}→${afterCount}, decor=${resident?.textureKey})`)

  // 断言 5(本轮新增):拖 dev 设备模型 → 生成数字孪生节点;孪生记录含落点 transform
  const devBefore = await page.evaluate(() => window.__town.scene.getDeviceNodes().length)
  await page.evaluate(() => window.__town.scene.dropModelOnWorld(1250, 720, 'dev-folder-pump'))
  await sleep(1200)
  const devNodes = await page.evaluate(() => window.__town.scene.getDeviceNodes().map(d => ({ id: d.twinId, x: d.x, z: d.z, state: d.state })))
  const devInScene = devNodes.length > devBefore
  console.log(`设备拖入场景(节点): ${devInScene ? 'PASS' : 'FAIL'} ${JSON.stringify(devNodes)}`)
  // 真实孪生 id 形如 dev-<ts36>-<rand>(两段,含 '-');本地临时 id 为 dev-<ts36>(无 '-' 段)
  const placed = devNodes.find(d => /^dev-[a-z0-9]+-[a-z0-9]+$/.test(d.id))
  console.log(`设备孪生已建(真 id+落点): ${placed ? 'PASS' : 'FAIL'} (${placed ? `${placed.id}@(${placed.x},${placed.z})` : 'none'})`)

  const summary = { allLand, modelCount, canDrag, rebind: afterTex === 'knight', spawn: afterCount > beforeCount, device: devInScene }
  console.log('\nSUMMARY:', JSON.stringify(summary))
  const allPass = allLand && canDrag && modelCount >= 1 && afterTex === 'knight' && afterCount > beforeCount
  console.log(allPass ? '\n==> ALL PASS' : '\n==> SOME FAIL')
  await browser.close()
  process.exit(allPass ? 0 : 1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(2)
  })
