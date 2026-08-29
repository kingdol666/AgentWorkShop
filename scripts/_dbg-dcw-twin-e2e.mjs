/** E2E:数字孪生智控通道全链路 —— 添加智控通道按钮/检查器绑定/面板直写/配方窗口/越限阻断 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.AW_TOKEN ?? 'ut-258a3578a5f2450d92416c08d1c1205f'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const { makeLineFixture } = await import('./_lib-dcw-line.mjs')
const fx = await makeLineFixture(ROOT, H, 'twin-e2e 产线')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const getNode = async (id) => (await (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H })).json()).data.nodes.find(n => n.id === id)

// ---------- REST 前置:专属全新设备孪生 + 产品 + 配方(窗口 176~188) ----------
const dev = (await (await fetch(`${ROOT}/api/workshop/device-twins`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ name: 'E2E 孪生验收机', modelRef: 'dev-folder-extruder', kind: 'device', posX: 2400, posZ: 900 }),
})).json()).data.twin
console.log('device:', dev.id, dev.name)

const prod = (await (await fetch(`${ROOT}/api/workshop/dcw/products`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'E2E产品', lineId: fx.line.id }) })).json()).data.product
// 窗口验证节点:显式挂产线 + 绑定设备;配方参数 nodeId 显式指向它(节点级绑定语义)
const dwWin = (await (await fetch(`${ROOT}/api/workshop/dcw`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ templateRef: 'dcw-temp-sp', name: 'E2E-窗口温度', lineId: fx.line.id, deviceBindingId: dev.id, posX: 2440, posZ: 860 }),
})).json()).data.node
const rc = (await (await fetch(`${ROOT}/api/workshop/dcw/recipes`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ productId: prod.id, name: 'E2E配方', params: [{ templateRef: 'dcw-temp-sp', nodeId: dwWin.id, value: 182, min: 176, max: 188 }] }),
})).json()).data.recipe
const lineStart = await fx.start(rc.id)
console.log('line active:', lineStart.data?.line?.active)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1400'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1400 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const pageErrors = []
page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 160)))
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
await sleep(2500)

// ---------- 1. 编辑模式 → 选中设备 → 两个添加按钮并存且顺序正确 ----------
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑')?.click()
})
await sleep(600)
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dev.id)
await sleep(800)
const btnLayout = await page.evaluate(() => {
  const adds = [...document.querySelectorAll('.bind-add')].map(b => b.textContent.trim())
  return { adds, hasDcwBtn: adds.includes('＋ 添加智控通道'), afterDaq: adds.indexOf('＋ 添加智控通道') === adds.indexOf('＋ 添加数采通道') + 1 }
})
console.log('add buttons:', JSON.stringify(btnLayout))
if (!btnLayout.hasDcwBtn || !btnLayout.afterDaq) fail(`添加智控通道按钮缺失或位置不对: ${JSON.stringify(btnLayout)}`)
else console.log('PASS 添加智控通道按钮位于添加数采通道之下')

// 输入后等 Vue 刷新 disabled 态再点击(否则首击落在仍禁用的按钮上)
async function panelWrite(page, name, val) {
  await page.evaluate(({ name, val }) => {
    const row = [...document.querySelectorAll('.dcw-row')].find(r => r.textContent.includes(name))
    if (!row) return
    const inp = row.querySelector('.dcw-write input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, String(val))
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, { name, val })
  await sleep(250)
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('.dcw-row')].find(r => r.textContent.includes(name))
    row?.querySelector('.dcw-send')?.click()
  }, name)
}

// ---------- 2. 点击添加智控通道 → 模板弹层 → 创建并自动绑定 ----------
await page.evaluate(() => {
  ;[...document.querySelectorAll('.bind-add')].find(b => b.textContent.trim() === '＋ 添加智控通道')?.click()
})
await sleep(500)
const popRows = await page.evaluate(() => [...document.querySelectorAll('.bind-pop button')].map(b => b.textContent.trim()))
console.log('dcw pop templates:', JSON.stringify(popRows))
if (!popRows.some(t => t.includes('温度设定器'))) fail(`模板弹层缺温度设定器: ${JSON.stringify(popRows)}`)
const beforeCnt = (await (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H })).json()).data.nodes
  .filter(n => n.templateRef === 'dcw-temp-sp').length
await page.evaluate(() => {
  ;[...document.querySelectorAll('.bind-pop button')].find(b => b.textContent.includes('温度设定器'))?.click()
})
await sleep(2500)
const nodes1 = (await (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H })).json()).data.nodes
const created = nodes1.filter(n => n.templateRef === 'dcw-temp-sp')
const boundNew = created.find(n => n.deviceBindingId === dev.id && n.id !== dwWin.id)
console.log(`dcw temp nodes ${beforeCnt} -> ${created.length}; bound to dev: ${boundNew?.id ?? 'none'}`)
// 设计策略:优先就近复用未绑定节点(计数不变但新增绑定),无复用目标才新建;新建通道继承设备产线
if (!boundNew) fail('添加智控通道未创建/绑定节点')
else {
  const lineOk = !boundNew.lineId || boundNew.lineId === fx.line.id
  if (lineOk) console.log(`PASS 添加智控通道生效(${created.length > beforeCnt ? '新建并绑定' : '就近复用未绑定节点并绑定'};产线归属 ${boundNew.lineId || '未分配'})`)
  else fail(`新建通道产线归属错误: ${boundNew.lineId}`)
}
const dcwId = boundNew?.id
const dcwName = boundNew?.name

// ---------- 3. 选中智控节点(dwWin:配方参数显式指向它)→ 检查器 ----------
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dwWin.id)
await sleep(800)
const insp = await page.evaluate(() => ({
  title: [...document.querySelectorAll('.inspector h3')].map(h => h.textContent.trim()).find(t => t.includes('智控')),
  chip: [...document.querySelectorAll('.ins-chip')].some(c => c.textContent.trim() === 'DCW'),
  hasBindSel: document.body.textContent.includes('选择设备实例…'),
  hasWrite: document.body.textContent.includes('下发 write'),
  winLabel: [...document.querySelectorAll('.daq-info-row')].map(r => r.textContent).find(t => t.includes('配方工艺窗口') || t.includes('节点量程')) ?? '',
}))
console.log('dcw inspector:', JSON.stringify(insp))
if (!(insp.title && insp.chip && insp.hasWrite)) fail(`智控检查器不完整: ${JSON.stringify(insp)}`)
else if (!insp.winLabel.includes('176') || !insp.winLabel.includes('188')) fail(`检查器窗口未按配方展示: ${insp.winLabel}`)
else console.log('PASS 智控节点检查器:标题/芯片/直写/配方窗口 176~188')

// ---------- 4. 检查器内解绑 → 重新绑定设备(双向验证;切到 UI 新增的通道) ----------
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dcwId)
await sleep(600)
if (insp.hasBindSel) {
  const dbg = await page.evaluate(() => ({
    bars: [...document.querySelectorAll('.daq-bind-bar')].map(b => [...b.querySelectorAll('button')].map(x => x.textContent.trim())),
    devNames: [...document.querySelectorAll('.daq-info-row')].map(r => r.textContent.trim()),
  }))
  console.log('bind-bar debug:', JSON.stringify(dbg))
  await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.daq-bind-bar')]
    const bar = bars.find(b => [...b.querySelectorAll('button')].some(x => x.textContent.trim() === '解绑'))
    bar?.querySelector('button')?.click()
  })
  await sleep(1500)
  const nU = await getNode(dcwId)
  if (!nU?.deviceBindingId) console.log('PASS 检查器解绑生效')
  else fail(`解绑未生效: ${nU?.deviceBindingId}`)
  await page.evaluate((devName) => {
    const sel = [...document.querySelectorAll('.daq-bind-bar select')].find(s => s.textContent.includes('选择设备实例…'))
    if (!sel) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    const opt = [...sel.options].find(o => o.textContent.trim() === devName)
    if (!opt) return
    setter.call(sel, opt.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, dev.name)
  await sleep(300)
  await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.daq-bind-bar')]
    const bar = bars.find(b => [...b.querySelectorAll('button')].some(x => x.textContent.trim() === '绑定'))
    bar?.querySelector('button')?.click()
  })
  await sleep(1500)
  const n1 = await getNode(dcwId)
  if (n1?.deviceBindingId === dev.id) console.log('PASS 检查器重新绑定设备成功')
  else fail(`重新绑定失败: ${n1?.deviceBindingId}`)
}

// ---------- 5. 设备面板:智控设定行 + 配方窗口 + 越窗阻断 + 窗内直写 ----------
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dev.id)
await sleep(800)
await panelWrite(page, dwWin.name, 195)
await sleep(900)
const overErr = await page.evaluate(() => [...document.querySelectorAll('.dcw-row .dcw-err')].map(e => e.textContent).find(t => t) ?? '')
console.log('over-window hint:', overErr.slice(0, 80))
if (overErr.includes('配方工艺窗口')) console.log('PASS 越窗 195 前端阻断并提示配方工艺窗口')
else fail(`越窗提示缺失: ${overErr}`)

await panelWrite(page, dwWin.name, 180)
await sleep(1500)
const n2 = await getNode(dwWin.id)
console.log('in-window write: value =', n2?.value, 'state =', n2?.state)
if (n2?.value === 180 && n2?.state === 'ok') console.log('PASS 窗内 180 直写成功且 server ACK')
else fail(`窗内直写失败: ${n2?.value}/${n2?.state}`)

await page.screenshot({ path: 'docs/audit/screenshots/town-dcw-twin-e2e.png' })
if (pageErrors.length) { console.error('pageerrors:', pageErrors.slice(0, 3)); fail('页面存在 JS 错误') }

// ---------- 清理(停线 + 删除审计数据与本测试创建的设备) ----------
await fx.cleanup()
await fetch(`${ROOT}/api/workshop/dcw/${dwWin.id}`, { method: 'DELETE', headers: H })
await fetch(`${ROOT}/api/workshop/dcw/${dcwId}`, { method: 'DELETE', headers: H })
await fetch(`${ROOT}/api/workshop/dcw/recipes/${rc.id}`, { method: 'DELETE', headers: H })
await fetch(`${ROOT}/api/workshop/dcw/products/${prod.id}`, { method: 'DELETE', headers: H })
await fetch(`${ROOT}/api/workshop/device-twins/${dev.id}`, { method: 'DELETE', headers: H })
await browser.close()
console.log(process.exitCode ? 'E2E FAILED' : 'E2E ALL PASS')
