/** 真实场景端到端审计:双产线建节点/采集/写入/配方数采窗口越限报警/孪生渲染/UI 交互 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jpatch = (u, b) => fetch(ROOT + u, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())

const daqNodes = () => jget('/api/workshop/daq').then(d => d.data.nodes)
const dcwNodes = () => jget('/api/workshop/dcw').then(d => d.data.nodes)

// ============ 1. 建两条产线 ============
const mkLine = async (name) => (await jpost('/api/workshop/dcw/lines', { name })).data.line
const lineA = await mkLine('场景-1号产线')
const lineB = await mkLine('场景-2号产线')
if (!lineA || !lineB) { console.error('FAIL: create lines'); process.exit(1) }
console.log('lines:', lineA.name, lineA.color, '|', lineB.name, lineB.color)

// ============ 2. 每线建数采 + 数控节点(mock 驱动;绑定同一设备便于孪生联动) ============
const twins = (await jget('/api/workshop/device-twins')).data.twins.filter(t => t.kind !== 'daq')
const dev = twins.find(t => t.name.includes('控制台')) ?? twins[0]
const mkD = async (base, body) => (await jpost(base, body)).data.node
const dqA = await mkD('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: '场景-温度采集A', lineId: lineA.id, intervalMs: 500, posX: dev.posX + 60, posZ: dev.posZ + 60 })
const dwA = await mkD('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: '场景-温度设定A', lineId: lineA.id, posX: dev.posX - 60, posZ: dev.posZ - 60 })
const dqB = await mkD('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: '场景-温度采集B', lineId: lineB.id, intervalMs: 500, posX: dev.posX + 120, posZ: dev.posZ + 120 })
const dwB = await mkD('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: '场景-温度设定B', lineId: lineB.id, posX: dev.posX - 120, posZ: dev.posZ - 120 })
for (const [n, id] of [[dqA, dqA.id], [dwA, dwA.id], [dqB, dqB.id], [dwB, dwB.id]]) {
  await jpost(`/api/workshop/${n === dqA || n === dqB ? 'daq' : 'dcw'}/${id}/bind`, { deviceId: dev.id })
}
console.log('nodes created: A(daq+dcw) B(daq+dcw), bound to', dev.name)

// ============ 3. 每线产品 + 配方(参数节点级 + 数采监控窗口) ============
const prodA = (await jpost('/api/workshop/dcw/products', { name: '场景产品A', lineId: lineA.id })).data.product
const prodB = (await jpost('/api/workshop/dcw/products', { name: '场景产品B', lineId: lineB.id })).data.product
const rcA = (await jpost('/api/workshop/dcw/recipes', {
  productId: prodA.id, name: '场景配方A',
  params: [{ templateRef: 'dcw-temp-sp', nodeId: dwA.id, value: 180, min: 176, max: 188 }],
  // 数采监控窗口:初始宽松(全量程内,不报警)
  daqWindows: [{ nodeId: dqA.id, min: 100, max: 260 }],
})).data.recipe
const rcB = (await jpost('/api/workshop/dcw/recipes', {
  productId: prodB.id, name: '场景配方B',
  params: [{ templateRef: 'dcw-temp-sp', nodeId: dwB.id, value: 165, min: 156, max: 170 }],
  daqWindows: [{ nodeId: dqB.id, min: 100, max: 260 }],
})).data.recipe
if (!rcA?.daqWindows?.length || !rcB?.daqWindows?.length) { console.error('FAIL: recipe daqWindows missing', JSON.stringify(rcA)); process.exit(1) }
console.log('recipes with daq windows:', rcA.name, JSON.stringify(rcA.daqWindows))

// ============ 4. 开跑 A 线:采集/写入/窗口联锁 ============
const st = await jpost(`/api/workshop/dcw/lines/${lineA.id}/start`, { recipeId: rcA.id })
if (!st.data?.line?.active) { console.error('FAIL: line A start', JSON.stringify(st).slice(0, 140)); process.exit(1) }
await sleep(3000)

const daqNow = await daqNodes()
const dqALive = daqNow.find(n => n.id === dqA.id)
console.log('A daq value:', dqALive?.value, dqALive?.state)
if (dqALive?.value != null && dqALive?.state !== 'offline') console.log('PASS A 线数采流动(500ms 周期)')
else fail('A 线无数采数据')

const dqBLive = daqNow.find(n => n.id === dqB.id)
if (dqBLive?.value == null || dqBLive?.state === 'offline') console.log('PASS B 线未开跑 → 不采集(产线隔离)')
else fail('B 线未开跑却在采样')

// 数控写入:窗口内 180 OK;越窗 195 拒绝(服务端配方联锁)
const wIn = await jpost(`/api/workshop/dcw/${dwA.id}/write`, { value: 180 })
const wOut = await jpost(`/api/workshop/dcw/${dwA.id}/write`, { value: 195 })
if (wIn.data?.outcome?.ok === true) console.log('PASS A 线数控写入 180 成功(真实下发链路)')
else fail(`A 线写入失败: ${JSON.stringify(wIn).slice(0, 100)}`)
if (wOut.code === 'VALIDATION_ERROR') console.log('PASS A 线越窗写入 195 被配方联锁拒绝:', (wOut.message ?? '').slice(0, 44))
else fail('A 线越窗写入未被拒绝')

// 跨线联锁隔离:B 线节点(A 线配方不含)写 195 不受 A 配方约束
const wCross = await jpost(`/api/workshop/dcw/${dwB.id}/write`, { value: 195 })
if (wCross.data?.outcome?.ok === true) console.log('PASS 跨线隔离:B 线节点不受 A 线配方窗口约束')
else fail('跨线联锁泄漏')

// ============ 5. 配方数采窗口越限 → 实时报警 ============
const dwNarrow = await jpatch(`/api/workshop/dcw/recipes/${rcA.id}`, { daqWindows: [{ nodeId: dqA.id, min: 0, max: 1 }] })
if (!dwNarrow.data?.recipe) { console.error('FAIL: patch narrow window', JSON.stringify(dwNarrow).slice(0, 120)); process.exit(1) }
console.log('narrow window [0,1] applied — 等待越限报警…')
let alarmed = false
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  const n = (await daqNodes()).find(x => x.id === dqA.id)
  if (n?.state === 'alarm') { alarmed = true; break }
}
const alVal = (await daqNodes()).find(x => x.id === dqA.id)
if (alarmed) console.log('PASS 配方窗口越限 → 节点实时 alarm(值', alVal.value, '∉ [0,1])')
else fail('越限未触发 alarm')

// 恢复宽窗口 → 自动回落 ok
await jpatch(`/api/workshop/dcw/recipes/${rcA.id}`, { daqWindows: [{ nodeId: dqA.id, min: 100, max: 260 }] })
let recovered = false
for (let i = 0; i < 10; i++) {
  await sleep(1000)
  const n = (await daqNodes()).find(x => x.id === dqA.id)
  if (n?.state === 'ok') { recovered = true; break }
}
if (recovered) console.log('PASS 窗口恢复 → 状态自动回落 ok')
else fail('窗口恢复后未回落')

// ============ 6. 停 A 开 B:采集切换 + B 配方生效 ============
await jpost(`/api/workshop/dcw/lines/${lineA.id}/stop`, {})
const stB = await jpost(`/api/workshop/dcw/lines/${lineB.id}/start`, { recipeId: rcB.id })
if (!stB.data?.line?.active) fail('line B start failed')
await sleep(3000)
const after = await daqNodes()
const aAfter = after.find(n => n.id === dqA.id)
const bAfter = after.find(n => n.id === dqB.id)
if (aAfter?.state === 'offline') console.log('PASS A 停 → A 节点 offline')
else fail(`A 停后未 offline: ${aAfter?.state}`)
if (bAfter?.value != null && bAfter?.state !== 'offline') console.log('PASS B 开 → B 数采流动(隔离切换)')
else fail('B 开后无数采')

// B 配方写入窗口(156~170):165 OK
const wB = await jpost(`/api/workshop/dcw/${dwB.id}/write`, { value: 165 })
if (wB.data?.outcome?.ok === true) console.log('PASS B 线配方窗口内写入 165 成功')
else fail('B 线写入失败')

// ============ 7. 浏览器:/daq 行标红 + /town 孪生报警 ============
// 重新制造 A 线越限(A 线已停 → 用 B 线验证浏览器报警链)
const dwNarrowB = await jpatch(`/api/workshop/dcw/recipes/${rcB.id}`, { daqWindows: [{ nodeId: dqB.id, min: 0, max: 1 }] })
if (!dwNarrowB.data?.recipe) fail('patch B narrow failed')
let alarmedB = false
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  const n = (await daqNodes()).find(x => x.id === dqB.id)
  if (n?.state === 'alarm') { alarmedB = true; break }
}
if (!alarmedB) fail('B 越限未报警')
else console.log('B 线越限报警就绪 — 开始浏览器验证')

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 120)))

// 7.1 /daq 页:页面挂载后制造越限跳变 → 行标红 + pill 文案 + 告警面板
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 90000 })
// 首访页面 dev server 需现场编译 → 轮询等行渲染
let rowReady = false
for (let i = 0; i < 30; i++) {
  rowReady = await page.evaluate((name) => [...document.querySelectorAll('tbody tr')].some(r => r.textContent.includes(name)), '场景-温度采集B')
  if (rowReady) break
  await sleep(1000)
}
if (!rowReady) fail('/daq 行未渲染(等待超时)')

// 恢复宽窗口 → 等回 ok → 收窄制造页面内的状态跳变(alarm 由 watch 实时上屏)
await jpatch(`/api/workshop/dcw/recipes/${rcB.id}`, { daqWindows: [{ nodeId: dqB.id, min: 100, max: 260 }] })
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  const n = (await daqNodes()).find(x => x.id === dqB.id)
  if (n?.state === 'ok') break
}
await jpatch(`/api/workshop/dcw/recipes/${rcB.id}`, { daqWindows: [{ nodeId: dqB.id, min: 0, max: 1 }] })
let daqUi = { rowRed: false, pillText: '' }
for (let i = 0; i < 15; i++) {
  await sleep(1000)
  daqUi = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent.includes(name))
    return {
      rowFound: !!row,
      rowRed: row?.classList.contains('row-recipe-alarm') ?? false,
      pillText: row?.querySelector('.st-pill')?.textContent.trim() ?? '',
    }
  }, '场景-温度采集B')
  if (daqUi.rowRed && daqUi.pillText.includes('配方越限')) break
}
console.log('/daq ui:', JSON.stringify(daqUi))
if (daqUi.rowFound && daqUi.rowRed && daqUi.pillText.includes('配方越限')) console.log('PASS /daq 越限行标红 + 「配方越限」pill')
else fail(`/daq 行标红缺失: ${JSON.stringify(daqUi)}`)
await page.screenshot({ path: 'docs/audit/screenshots/scenario-daq-alarm.png' })

// 告警面板条目(跳变已在页面上发生 → raiseAlarm crit)
await sleep(500)
const alarmOnDaq = await page.evaluate((name) => [...document.querySelectorAll('.al-txt')].map(e => e.textContent).find(t => t.includes(name)) ?? '', '场景-温度采集B')

// 7.2 /town:孪生节点红环 + 实时告警
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
await sleep(4500)
// 页面就绪后制造跳变:先恢复(→ok)再收窄(→alarm),watch 实时上屏
await jpatch(`/api/workshop/dcw/recipes/${rcB.id}`, { daqWindows: [{ nodeId: dqB.id, min: 100, max: 260 }] })
let townOk = false
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  const n = (await daqNodes()).find(x => x.id === dqB.id)
  if (n?.state === 'ok') { townOk = true; break }
}
if (townOk) console.log('PASS 孪生页面内窗口恢复 → 状态回落 ok')
await jpatch(`/api/workshop/dcw/recipes/${rcB.id}`, { daqWindows: [{ nodeId: dqB.id, min: 0, max: 1 }] })
let townUi = { found: false, state: '', ring: '', alarmText: '' }
for (let i = 0; i < 15; i++) {
  await sleep(1000)
  townUi = await page.evaluate((id, name) => {
    const s = window.__town.scene
    const dev2 = [...s.deviceNodes.values()].find(x => x.twinId === id)
    return {
      found: !!dev2,
      state: dev2?.state ?? '',
      ring: dev2 ? `#${dev2.ring.material.color.getHexString()}` : '',
      alarmText: [...document.querySelectorAll('.al-txt')].map(e => e.textContent).find(t => t.includes('越限量程')) ?? '',
      alRows: [...document.querySelectorAll('.al-txt')].map(e => e.textContent.trim().slice(0, 40)),
    }
  }, dqB.id, '场景-温度采集B')
  if (townUi.state === 'alarm' && townUi.ring === '#ff6b5c' && townUi.alarmText) break
}
if (!townUi.alarmText) console.log('  [diag] al rows:', JSON.stringify(townUi.alRows))
console.log('/town ui:', JSON.stringify(townUi))
if (townUi.found && townUi.state === 'alarm' && townUi.ring === '#ff6b5c') console.log('PASS 孪生节点 alarm 状态 + 红环')
else fail(`孪生报警缺失: ${JSON.stringify(townUi)}`)
if (townUi.alarmText) console.log('PASS 实时告警面板出现越限告警:', townUi.alarmText.slice(0, 50))
else fail('告警面板无越限条目')
await page.screenshot({ path: 'docs/audit/screenshots/scenario-town-alarm.png' })
if (alarmOnDaq) console.log('PASS /daq 页告警面板同步出现越限条目')

// 7.3 /dcw/[lineId] 详情页渲染(A 线):节点表 + 配方卡 + 批次
await page.goto(`${ROOT}/dcw/${lineA.id}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await sleep(6000)
const detailUi = await page.evaluate(() => ({
  h1: document.querySelector('h1')?.textContent ?? '',
  hasRecipe: document.body.textContent.includes('场景配方A'),
}))
console.log('/dcw/[id] ui:', JSON.stringify(detailUi))
if (detailUi.h1.includes('1号产线') && detailUi.hasRecipe) console.log('PASS 产线详情页渲染(A 线数据)')
else fail(`详情页渲染异常: ${JSON.stringify(detailUi)}`)

if (pageErrors.length) { console.error('pageerrors:', pageErrors.slice(0, 3)); fail('页面 JS 错误') }
await browser.close()

// ============ 清理 ============
await jpost(`/api/workshop/dcw/lines/${lineB.id}/stop`, {})
for (const id of [dqA.id, dqB.id]) await jdel(`/api/workshop/daq/${id}`)
for (const id of [dwA.id, dwB.id]) await jdel(`/api/workshop/dcw/${id}`)
for (const id of [rcA.id, rcB.id]) await jdel(`/api/workshop/dcw/recipes/${id}`)
for (const id of [prodA.id, prodB.id]) await jdel(`/api/workshop/dcw/products/${id}`)
for (const id of [lineA.id, lineB.id]) await jdel(`/api/workshop/dcw/lines/${id}`)
console.log('cleanup done')

console.log(process.exitCode ? 'SCENARIO FAILED' : 'SCENARIO ALL PASS')
process.exit(process.exitCode ?? 0)
