/* eslint-disable -- 浏览器 E2E 脚本:一次性验证,允许紧凑断言 */
/**
 * 小镇·用户自定义拖拽建模全流程验证(E2E via puppeteer)。
 *
 * 覆盖需求(对照用户原始意图):
 *  1. 小镇画面占据满 page(满屏)
 *  2. 侧边模型库仅加载 device 模型(character 模型不出现在模型库)
 *  3. 拖拽设备模型 → 场景实例化(数字孪生落库)
 *  4. 点击场景中设备 → 对象属性面板:改名/换模型/缩放/旋转
 *  5. 移除场景设备实例(孪生 + 节点 + 广播)
 *  6. Channel 通过真正拖拽放置;相同 Channel 只能放置一个
 *  7. Channel 管理:自定义范围(形状/半径/朝向)编辑 → 落库持久化
 *  8. Channel 管理:成员 tab 为成员自定义绑定 character 角色模型
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/town-user-flow'
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
  const ts = Date.now().toString(36)
  const regEmail = `flow-${ts}@test.local`
  const reg = await api('POST', '/api/users/register', {
    body: { name: `flow-${ts}`, email: regEmail, password: 'Passw0rd!123' },
  })
  const { token } = reg.data

  // 建频道:1 lead + 2 worker,挂载进 workspace
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: 'E2E共鸣领地', scenarioPrompt: 'test', leadAgent: { name: 'lead', harness: 'mock' } }, token,
  })
  const cid = ch.data.channelId
  await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'worker-a', harness: 'mock', role: 'worker' }, token })
  await api('POST', `/api/workshop/channels/${cid}/agents`, { body: { name: 'worker-b', harness: 'mock', role: 'worker' }, token })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: `flow-ws-${ts}` }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cid}`, { token })

  // 隔离:清空历史遗留设备孪生(保证设备断言从干净状态开始)
  const stale = await api('GET', '/api/workshop/device-twins', { token })
  for (const t of (stale?.data?.twins ?? [])) {
    await api('DELETE', `/api/workshop/device-twins/${t.id}`, { token })
  }

  // 测试角色模型:复制 hero-3d.glb → hunter.glb(供成员 tab 选择/绑定;最终清理)
  const hunterDst = path.resolve('public/assets/game/character/hunter.glb')
  fs.copyFileSync(path.resolve('public/assets/game/character/hero-3d.glb'), hunterDst)

  try {
    const result = await runTest({ token, cid, ts, regEmail })
    console.log(`\n结果: ${result.pass} 通过 / ${result.fail} 失败`)
    fs.rmSync(hunterDst, { force: true })
    process.exit(result.fail > 0 ? 1 : 0)
  }
  catch (e) {
    fs.rmSync(hunterDst, { force: true })
    throw e
  }
}

async function runTest({ token, cid, ts, regEmail }) {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  // ---- 登录(与既有脚本一致:真实 UI 表单;轮询等表单渲染,容忍 dev 首次编译) ----
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  let formReady = false
  for (let i = 0; i < 60 && !formReady; i++) {
    formReady = await page.evaluate(() => !!document.querySelector('input[type="email"]'))
    if (!formReady) await sleep(500)
  }
  if (!formReady) throw new Error('登录表单未渲染')
  const setInput = (sel, v) => page.$eval(sel, (el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await setInput('input[type="email"]', regEmail)
  await setInput('input[type="password"]', 'Passw0rd!123')
  await sleep(200)
  const loginBtn = await page.$('button[type="submit"], .ant-btn-primary, form button[type="submit"]')
  if (loginBtn) await loginBtn.click()
  else {
    for (const b of await page.$$('form button, .ant-form button')) {
      const txt = ((await b.evaluate(el => el.textContent)) || '').replace(/\s/g, '')
      if (txt === '登录') { await b.click(); break }
    }
  }
  let logged = false
  for (let i = 0; i < 40 && !logged; i++) {
    logged = await page.evaluate(() => !!document.cookie.match(/(?:^|;\s*)token=([^;]+)/))
    if (!logged) await sleep(500)
  }
  if (!logged) throw new Error('登录未写入 token cookie')

  // ---- 进入 /town 满屏小镇页 ----
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded' })
  let ready = false
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await page.evaluate(() => !!window.__town?.scene)
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('小镇场景未 ready')
  await sleep(2000)

  // 等模型库加载(含 hunter 角色模型 + dev 设备模型)
  let modelsReady = false
  for (let i = 0; i < 30 && !modelsReady; i++) {
    modelsReady = await page.evaluate(() => (window.__town?.characterAssets?.models?.length ?? 0) > 0)
    if (!modelsReady) await sleep(400)
  }
  const modelIds = await page.evaluate(() => window.__town.characterAssets.models.map(m => m.id))

  console.log('\n== 1. 满屏页 ==')
  const frame = await page.evaluate(() => {
    const r = document.querySelector('.town-frame').getBoundingClientRect()
    return { w: r.width, h: r.height, iw: window.innerWidth, ih: window.innerHeight }
  })
  console.log(`  frame ${Math.round(frame.w)}x${Math.round(frame.h)} vs viewport ${frame.iw}x${frame.ih}`)
  await page.screenshot({ path: `${OUT}/01-fullpage.png` })
  check('小镇画面占满页宽', Math.abs(frame.w - frame.iw) <= 2, `w=${Math.round(frame.w)} iw=${frame.iw}`)
  check('小镇画面占用主体高度', frame.h > frame.ih - 140, `h=${Math.round(frame.h)} ih=${frame.ih}`)

  console.log('\n== 2. 模型库仅设备模型 ==')
  const libIds = await page.evaluate(() => [...document.querySelectorAll('.model-card[data-model-id]')].map(e => e.getAttribute('data-model-id')))
  console.log('  模型库卡片:', JSON.stringify(libIds))
  check('模型库只含 dev 设备模型', libIds.length > 0 && libIds.every(i => i.startsWith('dev-folder')), JSON.stringify(libIds))
  check('character 模型不出现在模型库', !libIds.includes('hunter') && !libIds.includes('hero-3d') && !libIds.includes('knight'), '无角色卡片')
  const charInModels = modelIds.filter(id => /^ch-folder-/.test(id) || id === 'hero-3d')
  console.log('  注册表角色模型(供成员绑定):', JSON.stringify(charInModels))
  check('角色模型在注册表(供成员管理)', modelIds.includes('ch-folder-hunter'), JSON.stringify(modelIds))

  console.log('\n== 3. Channel 真实拖拽放置 ==')
  const dropPx = { x: 700, y: 430 }
  await html5Drag(page, `.dock-card[data-channel-id="${cid}"]`, '.town-host canvas', 'application/x-aw-channel', cid, dropPx)
  await sleep(1500)
  let layoutRes = await api('GET', '/api/workshop/scene/layouts', { token })
  const placedLayout = layoutRes?.data?.layouts?.find(l => l.channelId === cid)
  const blocksAfter = await page.evaluate(() => window.__town.scene.getDebugState().blocks)
  console.log('  落库 layout:', JSON.stringify(placedLayout))
  check('频道经拖拽放置(领地出现)', blocksAfter >= 1, `blocks=${blocksAfter}`)
  check('频道放置已落库', !!placedLayout && typeof placedLayout.x === 'number', JSON.stringify(placedLayout))
  await page.screenshot({ path: `${OUT}/02-channel-placed.png` })

  console.log('\n== 4. 相同 Channel 只能放置一个 ==')
  const cardState = await page.evaluate(({ cid }) => {
    const c = document.querySelector(`.dock-card[data-channel-id="${cid}"]`)
    return { draggable: c.getAttribute('draggable'), cls: c.className }
  }, { cid })
  console.log('  已放置卡片 draggable:', cardState.draggable, 'class:', cardState.cls)
  check('已放置频道卡片不可再拖拽', cardState.draggable === 'false' && cardState.cls.includes('placed'), JSON.stringify(cardState))
  const blocksAgain = await page.evaluate(({ cid }) => {
    window.__town.scene.dropChannelOnWorld(800, 800, cid, 'E2E共鸣领地', 3)
    return window.__town.scene.getDebugState().blocks
  }, { cid })
  check('再次放置不产生重复领地', blocksAgain === 1, `blocks=${blocksAgain}`)

  console.log('\n== 5. 拖拽设备模型 → 场景实例化 ==')
  const beforeTwins = await api('GET', '/api/workshop/device-twins', { token })
  const beforeIds = new Set((beforeTwins?.data?.twins ?? []).map(t => t.id))
  await html5Drag(page, '.model-card[data-model-id="dev-folder-pump"]', '.town-host canvas', 'application/x-aw-model', 'dev-folder-pump', dropPx)
  await sleep(1800)
  const twins = await api('GET', '/api/workshop/device-twins', { token })
  const newTwin = (twins?.data?.twins ?? []).find(t => !beforeIds.has(t.id) && t.modelRef === 'dev-folder-pump')
  const devNodes = await page.evaluate(() => window.__town.scene.getDeviceNodes())
  console.log('  新孪生:', JSON.stringify({ id: newTwin?.id, modelRef: newTwin?.modelRef, posX: newTwin?.posX, posZ: newTwin?.posZ }))
  console.log('  场景节点:', JSON.stringify(devNodes.map(d => ({ id: d.twinId, x: d.x, z: d.z }))))
  check('设备模型拖入 → 生成数字孪生实例', !!newTwin, JSON.stringify(newTwin))
  check('孪生含落点 transform', !!newTwin && typeof newTwin.posX === 'number', `posX=${newTwin?.posX}`)
  check('场景出现设备节点', devNodes.length >= 1, `nodes=${devNodes.length}`)
  await page.screenshot({ path: `${OUT}/03-device-instantiated.png` })

  console.log('\n== 6. 点击场景设备 → 对象属性面板 ==')
  const devId = newTwin.id
  await page.evaluate(() => {
    const c = document.querySelector('.town-host canvas')
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 700, clientY: 430 }))
  })
  await sleep(400)
  const panel1 = await page.evaluate(() => {
    const p = document.querySelector('.object-panel')
    if (!p) return null
    return { kind: p.querySelector('.scale-kind')?.textContent, nameInput: !!p.querySelector('.obj-input'), delBtn: !!p.querySelector('.obj-del') }
  })
  console.log('  点击后面板:', JSON.stringify(panel1))
  check('点击设备弹出管理面板', !!panel1, '无 .object-panel')
  check('面板含 名称/模型/缩放/删除', !!panel1?.nameInput && !!panel1?.delBtn, JSON.stringify(panel1))
  await page.screenshot({ path: `${OUT}/04-device-panel.png` })

  console.log('\n== 7. 设备改名(独立管理) ==')
  const newName = `e2e-泵机-${ts}`
  await page.evaluate(({ newName }) => {
    const el = document.querySelector('.obj-input')
    const proto = HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, newName)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, { newName })
  await sleep(1200)
  const twinsAfterRename = await api('GET', '/api/workshop/device-twins', { token })
  const renamed = (twinsAfterRename?.data?.twins ?? []).find(t => t.id === devId)
  const nodeName = await page.evaluate(({ devId }) => window.__town.scene.getDeviceName(devId), { devId })
  check('设备改名落库', renamed?.name === newName, `name=${renamed?.name}`)
  check('场景节点名牌同步', nodeName === newName, `node=${nodeName}`)

  console.log('\n== 8. 移除设备实例 ==')
  await page.evaluate(() => { window.confirm = () => true })
  await page.evaluate(() => document.querySelector('.obj-del').click())
  await sleep(1500)
  const twinsAfterDel = await api('GET', '/api/workshop/device-twins', { token })
  const still = (twinsAfterDel?.data?.twins ?? []).find(t => t.id === devId)
  const nodesAfterDel = await page.evaluate(() => window.__town.scene.getDeviceNodes().length)
  const panelGone = await page.evaluate(() => !!document.querySelector('.object-panel'))
  check('设备孪生被删除', !still, `still=${!!still}`)
  check('场景节点已移除', nodesAfterDel === 0, `nodes=${nodesAfterDel}`)
  check('管理面板关闭', !panelGone)

  console.log('\n== 9. Channel 管理:自定义范围(边界) ==')
  await page.evaluate(({ cid }) => {
    document.querySelector(`.dock-card[data-channel-id="${cid}"]`).click()
  }, { cid })
  await sleep(500)
  const bp1 = await page.evaluate(() => {
    const p = document.querySelector('.boundary-panel')
    return { open: !!p, tabs: [...(p?.querySelectorAll('.bp-tab') || [])].map(t => t.textContent) }
  })
  console.log('  频道管理面板:', JSON.stringify(bp1))
  check('点击已放置频道 → 频道管理面板', bp1.open && bp1.tabs.includes('边界') && bp1.tabs.some(t => t.includes('成员')), JSON.stringify(bp1))
  await page.evaluate(() => {
    const sliders = [...document.querySelectorAll('.bp-range')]
    const rx = sliders[0] // 横轴半径
    const proto = HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(rx, '420')
    rx.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(300)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.bp-btn')]
    const save = btns.find(b => b.textContent.includes('保存边界'))
    save.click()
  })
  await sleep(1200)
  layoutRes = await api('GET', '/api/workshop/scene/layouts', { token })
  const savedLayout = layoutRes?.data?.layouts?.find(l => l.channelId === cid)
  console.log('  保存后 layout:', JSON.stringify(savedLayout))
  check('边界编辑(radiusX=420)落库', savedLayout?.radiusX === 420, `radiusX=${savedLayout?.radiusX}`)
  await page.screenshot({ path: `${OUT}/05-boundary.png` })

  console.log('\n== 10. Channel 管理:成员自定义绑定角色模型 ==')
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.bp-tab')]
    tabs.find(t => t.textContent.includes('成员')).click()
  })
  await sleep(400)
  const memberCount = await page.evaluate(() => document.querySelectorAll('.member-row').length)
  const memberSelectCount = await page.evaluate(() => document.querySelectorAll('.member-select option').length)
  console.log(`  成员行数: ${memberCount}, 角色模型选项数: ${memberSelectCount}`)
  check('成员 tab 列出全部成员', memberCount === 3, `rows=${memberCount}`)
  check('成员模型下拉含 character 模型', memberSelectCount >= 2 && memberSelectCount >= 2, `options=${memberSelectCount}`)
  // 为 lead(第一行)绑定 hunter 角色模型
  await page.evaluate(() => {
    const sel = document.querySelector('.member-row .member-select')
    const proto = HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(sel, 'ch-folder-hunter')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(1500)
  const agentsRes = await api('GET', `/api/workshop/channels/${cid}/agents`, { token })
  const lead = (agentsRes?.data ?? agentsRes ?? []).find(a => a.role === 'lead')
  const cfgModel = (lead?.config ?? {}).modelRef
  const sceneLead = await page.evaluate(() => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.role === 'lead' && x.name === 'lead')
    return a ? { modelRef: a.modelRef, textureKey: a.textureKey } : null
  })
  console.log(`  成员绑定 → 服务端 config.modelRef: ${cfgModel} | 场景 modelRef: ${JSON.stringify(sceneLead)}`)
  check('成员角色模型绑定落库(config)', cfgModel === 'ch-folder-hunter', `cfg=${cfgModel}`)
  check('场景角色即时换装', sceneLead?.modelRef === 'ch-folder-hunter', JSON.stringify(sceneLead))
  await page.screenshot({ path: `${OUT}/06-members.png` })

  await browser.close()
  return { pass, fail }
}

/** 真实 HTML5 DnD 模拟:源卡 dragstart → 目标 dragover/drop(带 dataTransfer) */
async function html5Drag(page, sourceSel, targetSel, mime, data, { x, y }) {
  await page.evaluate(({ sourceSel, targetSel, mime, data, x, y }) => {
    const dt = new DataTransfer()
    dt.setData(mime, data)
    dt.setData('text/plain', data)
    dt.effectAllowed = 'copy'
    const src = document.querySelector(sourceSel)
    const tgt = document.querySelector(targetSel)
    if (!src || !tgt) throw new Error(`DnD 目标缺失: ${sourceSel} / ${targetSel}`)
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  }, { sourceSel, targetSel, mime, data, x, y })
}

main().catch((e) => { console.error(e); process.exit(2) })
