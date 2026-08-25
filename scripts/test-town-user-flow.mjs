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
    const result = await runTest({ token, cid, ts })
    console.log(`\n结果: ${result.pass} 通过 / ${result.fail} 失败`)
    fs.rmSync(hunterDst, { force: true })
    process.exit(result.fail > 0 ? 1 : 0)
  }
  catch (e) {
    fs.rmSync(hunterDst, { force: true })
    throw e
  }
}

async function runTest({ token, cid, ts }) {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new', args: ['--no-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  // ---- 登录:注入真实登录 token cookie(经 session-restore 插件恢复会话;绕开 antd 表单的脆弱性) ----
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.setCookie({ name: 'token', value: token, url: BASE })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  let logged = false
  for (let i = 0; i < 50 && !logged; i++) {
    logged = await page.evaluate(() => !document.querySelector('.auth-gate') && !!document.cookie.match(/(?:^|;\s*)token=/))
    if (!logged) await sleep(500)
  }
  if (!logged) throw new Error('会话未通过 token cookie 恢复')

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
    return { open: !!p, tabs: [...(p?.querySelectorAll('.bp-tab') || [])].map(t => (t.textContent || '').trim()) }
  })
  console.log('  频道管理面板:', JSON.stringify(bp1))
  check('点击已放置频道 → 频道管理面板', bp1.open && bp1.tabs.includes('边界') && bp1.tabs.some(t => t.includes('成员')), JSON.stringify(bp1))
  await page.evaluate(() => {
    const sliders = [...document.querySelectorAll('.bp-range')]
    const rx = sliders[0] // 横轴半径(step=8 → 用步进对齐值 512)
    const proto = HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(rx, '512')
    rx.dispatchEvent(new Event('input', { bubbles: true }))
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
  check('边界编辑(radiusX=512)落库', savedLayout?.radiusX === 512, `radiusX=${savedLayout?.radiusX}`)
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

  // ================= 统计场景几何(世界→屏幕投影,与 TownScene3D 相机同构) =================
  const sceneGeo = () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const camState = () => page.evaluate(() => window.__town.scene.getCameraTarget())
  const cam = await camState()
  const geo = await sceneGeo()

  console.log('\n== 11. Agent 独立活动范围:框选绘制 ==')
  await page.evaluate(() => window.__town.scene.setMode('edit'))
  await sleep(400)
  // 点击 lead 角色选中它(用其 debug 位置反算屏幕坐标;pointerup 触发场景点选)
  const leadPos = await page.evaluate(({ cid }) => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.role === 'lead' && x.channelId === cid)
    return { x: a.x, y: a.y }
  }, { cid })
  const leadC = worldToClient(await camState(), geo, leadPos.x, leadPos.y)
  await page.evaluate(({ x, y }) => {
    const c = document.querySelector('.town-host canvas')
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }))
  }, { x: leadC.x, y: leadC.y })
  await sleep(400)
  const rp1 = await page.evaluate(() => {
    const p = document.querySelector('.object-panel')
    return { open: !!p, hasRange: !!p?.querySelector('.obj-mini'), status: p?.querySelector('.range-status')?.textContent ?? '' }
  })
  console.log('  角色属性面板:', JSON.stringify(rp1))
  check('点击角色 → 对象面板含活动范围区块', rp1.open && rp1.hasRange, JSON.stringify(rp1))
  // 点「框选绘制」进入绘制模式
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.obj-mini')]
    const draw = btns.find(b => (b.textContent || '').includes('框选绘制'))
    if (draw) draw.click()
  })
  await sleep(300)
  const drawing = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.obj-mini')].find(x => (x.textContent || '').includes('绘制中'))
    return b ? b.className : ''
  })
  check('框选绘制模式激活(按钮高亮)', drawing.includes('on'), `cls=${drawing}`)
  // 在 lead 周围拉一个框:范围半径 ≈ 120×80(居中,避免贴近频道边界导致被钳制收缩)
  const rFrom = worldToClient(await camState(), geo, leadPos.x - 120, leadPos.y - 80)
  const rTo = worldToClient(await camState(), geo, leadPos.x + 120, leadPos.y + 80)
  await canvasDrag(page, rFrom, rTo)
  await sleep(1300)
  const agentsResR = await api('GET', `/api/workshop/channels/${cid}/agents`, { token })
  const leadR = (agentsResR?.data ?? agentsResR ?? []).find(a => a.role === 'lead')
  const cfgRange = leadR?.config?.range
  const sceneRange = await page.evaluate(() => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.role === 'lead')
    return a?.range ?? null
  })
  console.log(`  框选后 config.range: ${JSON.stringify(cfgRange)} | scene.range: ${JSON.stringify(sceneRange)}`)
  check('框选绘制生成 Agent 活动范围(场景)', !!sceneRange && sceneRange.shape === 'rect', JSON.stringify(sceneRange))
  check('范围配置落库(config.range)', !!cfgRange && typeof cfgRange.radiusX === 'number' && cfgRange.shape === 'rect', JSON.stringify(cfgRange))
  check('范围中心围绕角色落点', !!cfgRange && Math.abs(cfgRange.x - leadPos.x) < 200 && Math.abs(cfgRange.z - leadPos.y) < 200, JSON.stringify({ cfgRange, leadPos }))
  await page.screenshot({ path: `${OUT}/07-agent-range-drawn.png` })

  console.log('\n== 12. Agent 活动范围:滑杆扩张 + 落库 ==')
  // 对象面板横轴滑杆(第一个 .obj-range)调到 320;input 实时、change 提交落库
  await page.evaluate(() => {
    const sliders = [...document.querySelectorAll('.obj-range')]
    const rx = sliders[0]
    const proto = HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(rx, '320')
    rx.dispatchEvent(new Event('input', { bubbles: true }))
    rx.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(1200)
  const agentsResR2 = await api('GET', `/api/workshop/channels/${cid}/agents`, { token })
  const leadR2 = (agentsResR2?.data ?? agentsResR2 ?? []).find(a => a.role === 'lead')
  const cfgRange2 = leadR2?.config?.range
  console.log(`  滑杆扩张后 config.range: ${JSON.stringify(cfgRange2)}(扩张前 radiusX=${cfgRange?.radiusX})`)
  check('滑杆扩张范围后落库(radiusX 增大)', (cfgRange2?.radiusX ?? 0) >= ((cfgRange?.radiusX ?? 0) + 40), `rx ${cfgRange?.radiusX} → ${cfgRange2?.radiusX}`)

  console.log('\n== 13. Agent 活动范围:清除回退频道 ==')
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.obj-mini')]
    const clear = btns.find(b => (b.textContent || '').includes('清除范围'))
    if (clear) clear.click()
  })
  await sleep(1200)
  const agentsResR3 = await api('GET', `/api/workshop/channels/${cid}/agents`, { token })
  const leadR3 = (agentsResR3?.data ?? agentsResR3 ?? []).find(a => a.role === 'lead')
  const sceneRange3 = await page.evaluate(() => {
    const a = window.__town.scene.getDebugState().agents.find(x => x.role === 'lead')
    return a?.range ?? null
  })
  console.log('  清除后 config.range:', JSON.stringify(leadR3?.config?.range), 'scene.range:', JSON.stringify(sceneRange3))
  check('清除后 config.range 归空(回退频道边界)', !leadR3?.config?.range, JSON.stringify(leadR3?.config?.range))
  check('清除后场景范围移除', sceneRange3 === null, JSON.stringify(sceneRange3))
  await page.screenshot({ path: `${OUT}/08-agent-range-cleared.png` })

  console.log('\n== 14. 频道整体拖拽移动 ==')
  await page.evaluate(() => window.__town.scene.setMode('edit'))
  await sleep(400)
  const layBefore = await page.evaluate(({ cid }) => {
    const l = window.__town.scene.getChannelLayout(cid)
    return { x: l.x, z: l.z, radiusX: l.radiusX, radiusZ: l.radiusZ }
  }, { cid })
  // 起点选在领地内部、远离成员角色与边界手柄的内点(避免 pickAt 命中角色 / 手柄);
  // 拖拽位移 = 终点 − 起点,与起点在领地内的相对偏移无关
  const sx = layBefore.x + 120
  const sz = layBefore.z + 60
  const fromC = worldToClient(cam, geo, sx, sz)
  const toC = worldToClient(cam, geo, sx + 260, sz + 180)
  await canvasDrag(page, fromC, toC)
  await sleep(1400)
  const layMoved = await page.evaluate(({ cid }) => {
    const l = window.__town.scene.getChannelLayout(cid)
    return { x: l.x, z: l.z }
  }, { cid })
  const movedOk = Math.abs(layMoved.x - (layBefore.x + 260)) <= 32 && Math.abs(layMoved.z - (layBefore.z + 180)) <= 32
  console.log(`  移动: (${layBefore.x},${layBefore.z}) → (${layMoved.x},${layMoved.z})`)
  check('频道整体拖拽移动到自定义点位', movedOk, JSON.stringify(layMoved))
  const layServer1 = (await api('GET', '/api/workshop/scene/layouts', { token })).data.layouts.find(l => l.channelId === cid)
  check('频道移动已落库', Math.abs(layServer1.x - layMoved.x) <= 2 && Math.abs(layServer1.z - layMoved.z) <= 2, `server=(${layServer1.x},${layServer1.z})`)

  console.log('\n== 15. 边界手柄拖拽缩放 ==')
  // 重新聚焦频道 + 重取相机(拖拽移动时不聚焦,相机仍停在原位,手柄可能在取景外)
  await page.evaluate(({ cid }) => window.__town.scene.selectChannel(cid), { cid })
  await sleep(1000)
  const cam12 = await camState()
  const layB = await page.evaluate(({ cid }) => {
    const l = window.__town.scene.getChannelLayout(cid)
    return { x: l.x, z: l.z, radiusX: l.radiusX, radiusZ: l.radiusZ, rotationY: l.rotationY }
  }, { cid })
  const rot12 = (layB.rotationY || 0) * Math.PI / 180
  const hx = layB.x + layB.radiusX * Math.cos(rot12)
  const hz = layB.z + layB.radiusX * Math.sin(rot12)
  const hC = worldToClient(cam12, geo, hx, hz)
  const hTo = worldToClient(cam12, geo, hx + 160, hz)
  await canvasDrag(page, hC, hTo)
  await sleep(1300)
  const layR = await page.evaluate(({ cid }) => {
    const l = window.__town.scene.getChannelLayout(cid)
    return { radiusX: l.radiusX, radiusZ: l.radiusZ }
  }, { cid })
  console.log(`  缩放手柄: radiusX ${layB.radiusX} → ${layR.radiusX}`)
  check('边界手柄拖拽调整范围(radiusX 增大)', layR.radiusX > layB.radiusX + 30, `${layB.radiusX}→${layR.radiusX}`)
  const layServer2 = (await api('GET', '/api/workshop/scene/layouts', { token })).data.layouts.find(l => l.channelId === cid)
  check('边界缩放已落库', Math.abs(layServer2.radiusX - layR.radiusX) <= 2, `server rx=${layServer2.radiusX}`)
  await page.screenshot({ path: `${OUT}/07-handle-resize.png` })

  console.log('\n== 13. 移除频道 → 重新放置(同频道最多一个实例) ==')
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.bp-btn')]
    const rm = btns.find(b => b.textContent.includes('移除频道'))
    if (rm) rm.click()
  })
  await sleep(1600)
  const layGone = (await api('GET', '/api/workshop/scene/layouts', { token })).data.layouts.find(l => l.channelId === cid)
  const blocks0 = await page.evaluate(() => window.__town.scene.getDebugState().blocks)
  const cardAfter = await page.evaluate(({ cid }) => {
    const c = document.querySelector(`.dock-card[data-channel-id="${cid}"]`)
    return { draggable: c.getAttribute('draggable'), placed: c.className.includes('placed') }
  }, { cid })
  console.log('  移除后: layout=', !!layGone, ' blocks=', blocks0, ' 卡片=', JSON.stringify(cardAfter))
  check('频道移除后布局删除', !layGone && blocks0 === 0, `blocks=${blocks0}`)
  check('移除后卡片恢复可拖拽(可重新放置)', cardAfter.draggable === 'true' && !cardAfter.placed, JSON.stringify(cardAfter))
  await page.evaluate(() => window.__town.scene.setMode('browse'))
  await html5Drag(page, `.dock-card[data-channel-id="${cid}"]`, '.town-host canvas', 'application/x-aw-channel', cid, { x: 520, y: 520 })
  await sleep(1600)
  const layBack = (await api('GET', '/api/workshop/scene/layouts', { token })).data.layouts.find(l => l.channelId === cid)
  const blocks1 = await page.evaluate(() => window.__town.scene.getDebugState().blocks)
  console.log('  重新放置后: layout=', !!layBack, ' blocks=', blocks1)
  check('移除后重新拖拽放置成功', !!layBack && blocks1 === 1, `layout=${!!layBack} blocks=${blocks1}`)
  const blocksAgain2 = await page.evaluate(({ cid }) => {
    window.__town.scene.dropChannelOnWorld(900, 700, cid, 'E2E', 3)
    return window.__town.scene.getDebugState().blocks
  }, { cid })
  check('重新放置后同频道仍只一个实例(去重)', blocksAgain2 === 1, `blocks=${blocksAgain2}`)
  await page.screenshot({ path: `${OUT}/08-replaced.png` })

  console.log('\n== 14. 刷新后放置与边界恢复(持久化) ==')
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  let reReady = false
  for (let i = 0; i < 50 && !reReady; i++) {
    reReady = await page.evaluate(() => !!window.__town?.scene)
    if (!reReady) await sleep(500)
  }
  // 布局加载先于 WS 快照:rebuild 依赖实体基线,轮询等待快照重建领地
  let restored = { blocks: 0, chAgents: 0, hasLayout: false, radiusX: null }
  for (let i = 0; i < 30; i++) {
    restored = await page.evaluate(({ cid }) => {
      const s = window.__town.scene.getDebugState()
      const l = window.__town.scene.getChannelLayout(cid)
      const chAgents = s.agents.filter(a => a.channelId === cid).length
      return { blocks: s.blocks, chAgents, hasLayout: !!l, radiusX: l?.radiusX ?? null }
    }, { cid })
    if (restored.blocks >= 1 && restored.hasLayout) break
    await sleep(500)
  }
  console.log('  刷新后:', JSON.stringify(restored))
  check('刷新后频道领地恢复', restored.blocks >= 1 && restored.hasLayout, JSON.stringify(restored))
  check('刷新后边界设置保留(radiusX>默认)', (restored.radiusX ?? 0) >= 80, `radiusX=${restored.radiusX}`)
  check('刷新后频道成员落地', restored.chAgents === 3, `agents=${restored.chAgents}`)
  await page.screenshot({ path: `${OUT}/09-restored.png` })

  console.log('\n== 18. 实时信息接收器:FIFO 聊天气泡 ==')
  // 经 handleTownEvent 注入 3 条同频道短消息(顺序: lead → worker-a → worker-b),
  // 断言接收器按 FIFO 逐条消费:瞬时只显示第 1 条;随后用 debugAdvanceReceiver
  // 确定性推进,逐步验证 2、3 条按序渲染、各自挂在对应 Agent 头顶
  const bubbleIds = await page.evaluate(({ cid }) => {
    const s = window.__town.scene.getDebugState().agents.filter(a => a.channelId === cid)
    return {
      lead: s.find(a => a.role === 'lead')?.agentId,
      w1: s.find(a => a.name === 'worker-a')?.agentId,
      w2: s.find(a => a.name === 'worker-b')?.agentId,
    }
  }, { cid })
  await page.evaluate(({ cid, bubbleIds }) => {
    const scene = window.__town.scene
    const mk = (agentId, text) => ({
      v: 1, type: 'agent.message', seq: Math.floor(Math.random() * 1e6) + 1,
      at: new Date().toISOString(), channelId: cid, agentId,
      payload: { parts: [{ text }] },
    })
    scene.handleTownEvent(mk(bubbleIds.lead, '大家好,我们要开工了'))
    scene.handleTownEvent(mk(bubbleIds.w1, '收到,领队!'))
    scene.handleTownEvent(mk(bubbleIds.w2, '我这就去办。'))
  }, { cid, bubbleIds })
  const bubbleState = () => page.evaluate(({ cid }) => {
    return window.__town.scene.getDebugState().agents
      .filter(a => a.channelId === cid)
      .map(a => ({ name: a.name, bubble: a.bubbleText }))
  }, { cid })
  const advance = (cid) => page.evaluate(({ cid }) => window.__town.scene.debugAdvanceReceiver(cid), { cid })
  await sleep(500)
  const b1 = await bubbleState()
  console.log('  T+0.5s 当前气泡(应只有第 1 条):', JSON.stringify(b1))
  check('FIFO:注入后瞬时只渲染第 1 条', b1.some(a => a.bubble === '大家好,我们要开工了') && !b1.some(a => a.bubble === '收到,领队!') && !b1.some(a => a.bubble === '我这就去办。'), JSON.stringify(b1))
  await page.screenshot({ path: `${OUT}/10-bubble-1.png` })
  await advance(cid)
  await sleep(350)
  const b2 = await bubbleState()
  console.log('  推进一次后当前气泡(应为第 2 条):', JSON.stringify(b2))
  check('FIFO:推进后按序渲染第 2 条(worker-a)', b2.some(a => a.name === 'worker-a' && a.bubble === '收到,领队!') && !b2.some(a => a.bubble === '大家好,我们要开工了') && !b2.some(a => a.bubble === '我这就去办。'), JSON.stringify(b2))
  await advance(cid)
  await sleep(350)
  const b3 = await bubbleState()
  console.log('  再推进一次后当前气泡(应为第 3 条):', JSON.stringify(b3))
  check('FIFO:再次推进后按序渲染第 3 条(worker-b)', b3.some(a => a.name === 'worker-b' && a.bubble === '我这就去办。') && !b3.some(a => a.bubble === '收到,领队!'), JSON.stringify(b3))
  await advance(cid)
  await sleep(350)
  const b4 = await bubbleState()
  check('FIFO:队列消费完毕后气泡清空', b4.every(a => a.bubble === null), JSON.stringify(b4))
  await page.screenshot({ path: `${OUT}/11-bubble-drained.png` })

  console.log('\n== 19. 数据驱动模型:动画监听(motion)+ debug.anim ==')
  // motion 事件可订阅:场景内 Agent 走走停停漫游 → 动画状态在 idle/walk 间切换并广播
  const motionEvents = await page.evaluate(() => new Promise((resolve) => {
    const s = window.__town.scene
    const out = []
    let off = null
    off = s.on('motion', (e) => {
      if (e) out.push({ agentName: e.agentName, anim: e.anim })
      if (out.length >= 3 && off) { off(); resolve(out) }
    })
    setTimeout(() => { if (off) off(); resolve(out) }, 3500)
  }))
  console.log('  motion 事件:', JSON.stringify(motionEvents.slice(0, 3)))
  check('motion 事件可订阅(动画数据驱动)', (motionEvents?.length ?? 0) >= 1 && motionEvents.every(e => e.anim === 'idle' || e.anim === 'walk'), JSON.stringify(motionEvents.slice(0, 3)))
  const anims = await page.evaluate(({ cid }) => {
    return window.__town.scene.getDebugState().agents.filter(a => a.channelId === cid).map(a => a.anim)
  }, { cid })
  console.log('  debug.anim:', JSON.stringify(anims))
  check('debug.anim 随移动输出(idle/walk)', anims.length === 3 && anims.every(a => a === 'idle' || a === 'walk'), JSON.stringify(anims))
  await page.screenshot({ path: `${OUT}/12-data-driven.png` })

  await browser.close()
  return { pass, fail }
}

/** 世界坐标 → 屏幕坐标(与 TownScene3D 相机投影同构:dolly=1, fov=50, 高 620, 距 940) */
function worldToClient(cam, { w, h }, wx, wz) {
  const tx = cam.x
  const tz = cam.z
  const px = tx
  const py = 620
  const pz = tz + 940 * 0.76
  // forward = normalize(target - pos)
  let fx = tx - px
  let fy = 20 - py
  let fz = tz - pz
  const fl = Math.hypot(fx, fy, fz) || 1
  fx /= fl; fy /= fl; fz /= fl
  // right = normalize(cross(forward, up=(0,1,0))) = (-fz, 0, fx)
  const rl = Math.hypot(fz, fx) || 1
  const rx = -fz / rl
  const rz = fx / rl
  // up = cross(right, forward)
  const ux = -rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy
  const vx = wx - px
  const vy = 0 - py
  const vz = wz - pz
  const xc = vx * rx + vz * rz
  const yc = vx * ux + vy * uy + vz * uz
  const zc = vx * fx + vy * fy + vz * fz
  const fov = (50 * Math.PI) / 180
  const aspect = w / h
  const zSafe = Math.max(1, zc)
  const ndcx = xc / (zSafe * Math.tan(fov / 2) * aspect)
  const ndcy = yc / (zSafe * Math.tan(fov / 2))
  return { x: Math.round((ndcx * 0.5 + 0.5) * w), y: Math.round((-ndcy * 0.5 + 0.5) * h) }
}

/** 场景指针拖拽:canvas pointerdown → window pointermove → window pointerup */
async function canvasDrag(page, from, to) {
  await page.evaluate(({ from, to }) => {
    const c = document.querySelector('.town-host canvas')
    if (!c) throw new Error('canvas 缺失')
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: from.x, clientY: from.y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: to.x, clientY: to.y }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: to.x, clientY: to.y }))
  }, { from, to })
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
