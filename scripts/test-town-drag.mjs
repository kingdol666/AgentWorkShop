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
  for (const b of await page.$$('button')) {
    if ((await b.evaluate(el => el.textContent) || '').replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(4500)

  await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
  await sleep(5500)

  // 等待场景 ready(模型库异步加载,单独断言)
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await page.evaluate(() => window.__town?.scene?.getDebugState?.()?.blocks > 0)
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('小镇场景未 ready')
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
  for (let i = 0; i < 15; i++) {
    libDom = await page.evaluate(() => ({
      lib: document.querySelectorAll('.asset-lib').length,
      cards: document.querySelectorAll('.model-card').length,
      cardIds: [...document.querySelectorAll('.model-card[data-model-id]')].map(e => e.getAttribute('data-model-id')),
    }))
    if (libDom.lib > 0) break
    await sleep(400)
  }
  console.log('AssetLibrary DOM:', JSON.stringify(libDom))
  const modelCount = libDom.cards
  const canDrag = libDom.cardIds.length > 0 && await page.$eval('.model-card[data-model-id]', el => el.getAttribute('draggable') === 'true').catch(() => false)
  console.log(`模型库卡数: ${modelCount} | 可拖拽: ${canDrag ? 'PASS' : 'FAIL'}`)

  // 断言 3:拖模型到某角色 → 换装(textureKey/modelRef 变 modelId)
  // 取第一个频道 worker
  const worker = agents.find(a => a.role === 'worker' && a.channelId)
  const beforeTex = worker.textureKey
  // 通过 HTML5 drag 模拟:设置 dataTransfer 后 page.mouse 拖到该 worker 身上
  const world = await page.evaluate(({ target }) => {
    const s = window.__town.scene
    const cam = s.cameras.main
    const cv = s.game.canvas
    const rect = cv.getBoundingClientRect()
    const vx = (target.x - cam.worldView.x) / cam.worldView.width
    const vy = (target.y - cam.worldView.y) / cam.worldView.height
    return { px: rect.left + vx * rect.width, py: rect.top + vy * rect.height, rect }
  }, { target: worker })
  console.log('worker world→page:', Math.round(world.px), Math.round(world.py))
  // 页面坐标 → dispatch HTML5 drop(用 DragEvent 携带 dataTransfer)
  await page.evaluate(({ px, py, assetId }) => {
    const cv = window.__town.game.canvas
    const dt = new DataTransfer()
    dt.setData('application/x-aw-model', assetId)
    dt.setData('text/plain', assetId)
    const opts = { bubbles: true, cancelable: true, clientX: px, clientY: py, dataTransfer: dt }
    cv.dispatchEvent(new DragEvent('dragover', opts))
    cv.dispatchEvent(new DragEvent('drop', opts))
  }, { px: world.px, py: world.py, assetId: 'knight' })
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

  const summary = { allLand, modelCount, canDrag, rebind: afterTex === 'knight', spawn: afterCount > beforeCount }
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
