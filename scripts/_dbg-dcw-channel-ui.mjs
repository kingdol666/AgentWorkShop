/** 一次性:Town 智控通道 UI 审计 —— 配方窗口展示/面板直写/越窗提示/检查器绑定 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 前置:产品/配方(带工艺窗口,nodeId 显式指向 dwTemp)/智控节点 REST 建好并绑定
const prod = (await (await fetch(`${ROOT}/api/workshop/dcw/products`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'UI审计产品' }) })).json()).data.product
const dwTemp = (await (await fetch(`${ROOT}/api/workshop/dcw`, { method: 'POST', headers: H, body: JSON.stringify({ templateRef: 'dcw-temp-sp', name: 'UI审计-温度设定', posX: 700, posZ: 1500 }) })).json()).data.node
const dwPres = (await (await fetch(`${ROOT}/api/workshop/dcw`, { method: 'POST', headers: H, body: JSON.stringify({ templateRef: 'dcw-pressure-sp', name: 'UI审计-压力设定', posX: 820, posZ: 1500 }) })).json()).data.node
const twins = (await (await fetch(`${ROOT}/api/workshop/device-twins`, { headers: H })).json()).data.twins.filter(t => t.kind !== 'daq' && typeof t.posX === 'number')
const dev = twins[0]
await fetch(`${ROOT}/api/workshop/dcw/${dwTemp.id}/bind`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: dev.id }) })
const rc = (await (await fetch(`${ROOT}/api/workshop/dcw/recipes`, { method: 'POST', headers: H, body: JSON.stringify({ productId: prod.id, name: 'UI审计配方', params: [{ templateRef: 'dcw-temp-sp', nodeId: dwTemp.id, value: 182, min: 176, max: 188 }] }) })).json()).data.recipe
// 开跑(配方驱动采集 + 工艺窗口生效)
const st = await (await fetch(`${ROOT}/api/workshop/dcw/line/start`, { method: 'POST', headers: H, body: JSON.stringify({ recipeId: rc.id }) })).json()
console.log('line:', st.data?.line?.active)

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
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
await sleep(2500)

// 编辑模式 + 选中绑定设备
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  btns.find(b => b.textContent.trim() === '编辑')?.click()
})
await sleep(500)
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dev.id)
await sleep(800)
const panel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.dcw-row')]
  return {
    rows: rows.length,
    hasDcwSect: document.body.textContent.includes('智控设定'),
    recipeWin: rows.map(r => r.querySelector('.dcw-win')?.textContent ?? '').find(t => t.includes('配方窗口')) ?? '',
    rowHasTarget: rows.some(r => r.textContent.includes('UI审计-温度设定')),
  }
})
console.log('device panel:', JSON.stringify(panel))
if (panel.rows >= 1 && panel.rowHasTarget && panel.recipeWin.includes('176') && panel.recipeWin.includes('188')) {
  console.log(`PASS bound dcw channel shows recipe window: ${panel.recipeWin}`)
}
else fail(`panel/window wrong: ${JSON.stringify(panel)}`)

// 面板直写:越窗 195 → 前端阻断提示(输入与点击分两拍:v-model/:disabled 在 nextTick 才生效)
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.dcw-row')].find(r => r.textContent.includes('UI审计-温度设定'))
  if (!row) return
  const inp = row.querySelector('.dcw-write input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(inp, '195')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(200)
await page.evaluate(() => {
  [...document.querySelectorAll('.dcw-row')].find(r => r.textContent.includes('UI审计-温度设定'))?.querySelector('.dcw-send')?.click()
})
await sleep(800)
const overErr = await page.evaluate(() => [...document.querySelectorAll('.dcw-row .dcw-err')].map(e => e.textContent).find(t => t) ?? '')
console.log('over-window:', overErr.slice(0, 70))
if (overErr.includes('配方工艺窗口')) console.log('PASS over-window blocked frontend with hint')
else fail(`over-window hint missing: ${overErr}`)

// 窗内 180 → write 成功,server ACK
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.dcw-row')].find(r => r.textContent.includes('UI审计-温度设定'))
  if (!row) return
  const inp = row.querySelector('.dcw-write input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(inp, '180')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(200)
await page.evaluate(() => {
  [...document.querySelectorAll('.dcw-row')].find(r => r.textContent.includes('UI审计-温度设定'))?.querySelector('.dcw-send')?.click()
})
await sleep(1200)
const getNode = async (id) => (await (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H })).json()).data.nodes.find(n => n.id === id)
const dwNode = await getNode(dwTemp.id)
console.log('in-window write: node value =', dwNode?.value, dwNode?.state)
if (dwNode?.value === 180 && dwNode?.state === 'ok') console.log('PASS in-panel write dispatched')
else fail(`write failed: ${dwNode?.value}/${dwNode?.state}`)

// 选中智控节点 → 检查器(DCW 分支:窗口 + write + 设备绑定)
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, dwPres.id)
await sleep(700)
const sel2 = await page.evaluate(() => ({
  title: [...document.querySelectorAll('.inspector h3')].map(h => h.textContent).find(t => t?.includes('智控')),
  chip: [...document.querySelectorAll('.ins-chip')].map(c => c.textContent.trim()).find(t => t === 'DCW'),
  hasBind: document.body.textContent.includes('选择设备实例…'),
  hasWrite: document.body.textContent.includes('下发 write'),
}))
console.log('dcw selected:', JSON.stringify(sel2))
if (!(sel2.title && sel2.chip && sel2.hasBind && sel2.hasWrite)) fail(`dcw inspector wrong: ${JSON.stringify(sel2)}`)
else {
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('.daq-bind-bar select')].find(s => s.textContent.includes('选择设备实例…'))
    if (!sel) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    const opt = [...sel.options].find(o => o.value)
    setter.call(sel, opt.value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(300)
  await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.daq-bind-bar')]
    const bar = bars.find(b => [...b.querySelectorAll('button')].some(x => x.textContent.trim() === '绑定'))
    bar?.querySelector('button')?.click()
  })
  await sleep(1200)
  const bound = (await (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H })).json()).data.nodes.find(n => n.id === dwPres.id)
  if (bound?.deviceBindingId) console.log('PASS dcw node bound to device via inspector')
  else fail(`inspector bind failed: ${bound?.deviceBindingId}`)
}

await page.screenshot({ path: 'docs/audit/screenshots/town-dcw-channel.png' })
if (pageErrors.length) { console.error('pageerrors:', pageErrors.slice(0, 3)); fail('page errors present') }

// 清理(停线;删除审计节点/配方/产品)
await fetch(`${ROOT}/api/workshop/dcw/line/stop`, { method: 'POST', headers: H })
for (const id of [dwTemp.id, dwPres.id]) await fetch(`${ROOT}/api/workshop/dcw/${id}`, { method: 'DELETE', headers: H })
await fetch(`${ROOT}/api/workshop/dcw/recipes/${rc.id}`, { method: 'DELETE', headers: H })
await fetch(`${ROOT}/api/workshop/dcw/products/${prod.id}`, { method: 'DELETE', headers: H })
await browser.close()
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
