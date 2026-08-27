/**
 * DAQ 绑定渲染 + 薄膜双拉产线 审计(一次性调试脚本):
 *  - REST 铺一条薄膜产线(挤出→流延→MD→TD→收卷)+ 3 个数采节点;
 *  - localStorage 预置绑定 → 校验 syncDaqLinks 虚线/脉冲 + 膜 web + callouts;
 *  - 选中设备 → 校验 bind-row(图标/实时值/迷你折线)+ bind-pop 添加通道;
 *  - 收集 pageerror + 截图;结束后清理本脚本创建的孪生(不污染用户场景)。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

// ---------- 1) REST:铺产线 + 数采(位置沿 X 排开,间距 > 110 保证膜 web 成段) ----------
const lineZ = 1200
const spec = [
  { name: '挤出机 L1', ref: 'dev-folder-extruder', x: 1000, z: lineZ, kind: 'device' },
  { name: '流延冷却 L1', ref: 'dev-folder-caster', x: 1330, z: lineZ, kind: 'device' },
  { name: 'MD 纵拉机 L1', ref: 'dev-folder-mdo', x: 1680, z: lineZ, kind: 'device' },
  { name: 'TD 拉幅机 L1', ref: 'dev-folder-tdo', x: 2080, z: lineZ, kind: 'device' },
  { name: '收卷机 L1', ref: 'dev-folder-winder', x: 2430, z: lineZ, kind: 'device' },
  { name: '压力变送器 01', ref: 'daq-pressure-tx', x: 1060, z: lineZ + 70, kind: 'daq' },
  { name: '温度传感器 01', ref: 'daq-temp-tc', x: 1690, z: lineZ + 80, kind: 'daq' },
  { name: '张力传感器 01', ref: 'daq-tension-cell', x: 2100, z: lineZ + 80, kind: 'daq' },
]
const created = []
for (const s of spec) {
  const res = await fetch(`${BASE}/api/workshop/device-twins`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: s.name, modelRef: s.ref, kind: s.kind, posX: s.x, posZ: s.z }),
  })
  const j = await res.json().catch(() => ({}))
  const id = j?.data?.twin?.id ?? j?.data?.id
  if (res.ok && id) created.push({ ...s, id })
  else console.log(`CREATE_FAIL ${s.name}: ${res.status} ${JSON.stringify(j).slice(0, 120)}`)
}
console.log(`created ${created.length}/${spec.length}`)
const byName = Object.fromEntries(created.map(c => [c.name, c.id]))
// 绑定:压力→挤出机,温度→MD,张力→TD(设计稿演示场景同款)
const bindings = {
  [byName['压力变送器 01'] ?? 'x']: byName['挤出机 L1'] ?? 'y',
  [byName['温度传感器 01'] ?? 'x']: byName['MD 纵拉机 L1'] ?? 'y',
  [byName['张力传感器 01'] ?? 'x']: byName['TD 拉幅机 L1'] ?? 'y',
}

// ---------- 2) 浏览器审计 ----------
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument((b) => {
  localStorage.setItem('aw.twin.daqBindings', JSON.stringify(b))
}, bindings)
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(need => (window.__town?.scene?.agents?.size ?? 0) > 0 && (window.__town?.scene?.deviceNodes?.size ?? 0) >= need, created.length)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 5000))

// 3) 产线/绑定/标注核验
const probe = await page.evaluate((expectDevs) => {
  const s = window.__town.scene
  const devs = [...s.deviceNodes.values()]
  return {
    agents: s.agents?.size ?? 0,
    deviceNodes: s.deviceNodes?.size ?? 0,
    filmWebSegs: s.filmWebGroup?.children?.length ?? -1,
    daqLinkObjs: s.daqLinkGroup?.children?.length ?? -1,
    daqCards: document.querySelectorAll('.daq-card').length,
    callouts: document.querySelectorAll('.callout').length,
    libHasExtruder: [...document.querySelectorAll('.model-name')].some(el => (el.textContent ?? '').includes('挤出机')),
    lineDevs: devs.filter(d => /extruder|caster|mdo|tdo|winder/.test(d.modelRef)).length,
    expectDevs,
  }
}, created.filter(c => c.kind === 'device').length)
console.log('probe:', JSON.stringify(probe))

// 4) 选中 TD 拉幅机 → inspector bind-row + 迷你折线 + bind-pop 添加通道
const tdoId = byName['TD 拉幅机 L1'] ?? ''
await page.evaluate((id) => {
  window.__town.scene.setSelected({ kind: 'device', id })
}, tdoId)
await new Promise(r => setTimeout(r, 2500))
let insp = await page.evaluate(() => ({
  bindRows: document.querySelectorAll('.bind-row').length,
  spark: !!document.querySelector('.bind-row .bind-spark'),
  bindLabel: document.querySelector('.bind-row .bind-label')?.textContent ?? '',
  bindVal: document.querySelector('.bind-row .bind-val')?.textContent ?? '',
  bindAdd: !!document.querySelector('.bind-add'),
}))
console.log('insp:', JSON.stringify(insp))
await page.screenshot({ path: 'docs/audit/screenshots/town-film-inspector.png' })

// bind-pop:添加 速度编码器 通道(应实例化新数采并绑定)
await page.click('.bind-add')
await new Promise(r => setTimeout(r, 400))
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.bind-pop button')].find(b => (b.textContent ?? '').includes('速度编码器'))
  btn?.click()
})
await new Promise(r => setTimeout(r, 3500))
insp = await page.evaluate(() => ({
  bindRows: document.querySelectorAll('.bind-row').length,
  spark: !!document.querySelector('.bind-row .bind-spark'),
}))
const links2 = await page.evaluate(() => window.__town.scene.daqLinkGroup?.children?.length ?? -1)
console.log('after addChannel:', JSON.stringify(insp), 'links:', links2)

// 5) 全景视角 + 截图
await page.evaluate(() => {
  window.__town.scene.focusTo(1700, 1200)
})
await new Promise(r => setTimeout(r, 3000))
await page.screenshot({ path: 'docs/audit/screenshots/town-film-line.png' })
const final = await page.evaluate(() => ({
  callouts: document.querySelectorAll('.callout').length,
  calloutText: document.querySelector('.callout .co-label')?.textContent ?? '',
}))
console.log('final:', JSON.stringify(final))
console.log('pageerrors:', errors.length ? errors : 'none')

// ---------- 6) 清理本脚本创建的孪生 ----------
await page.close().catch(() => {})
await browser.close()
for (const c of created) {
  const res = await fetch(`${BASE}/api/workshop/device-twins/${c.id}`, { method: 'DELETE', headers: H })
  if (!res.ok) console.log(`CLEANUP_FAIL ${c.name}: ${res.status}`)
}
console.log(`cleanup done (${created.length} twins removed)`)
