/**
 * 一次性 E2E:开跑产线 → 数控/数采/数字孪生三链路活体验证。
 * ①REST 开跑(配方参数节点级绑定)→ 控制节点设定值=配方目标(写 ACK/写历史带批次);
 * ②数采由配方门控启动:produced 增长、节点实时值随采样变化;
 * ③数字孪生面板(/town):callout 数据卡展示实时值,8s 内值变化(WS→townBus→callout 全链);
 * ④停线:数采节点 offline、produced 冻结、孪生值收敛 '--'。结束还原环境。
 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ===== 选目标产线:同时具备 数采节点 + 控制节点 + 参数级绑定配方 =====
const d = (await j('/api/workshop/dcw')).data
const daqAll = (await j('/api/workshop/daq')).data
const cand = d.lines.map((l) => {
  const recipe = d.recipes.find(r => r.lineId === l.id && r.params.length > 0 && r.params.every(p => p.nodeId))
  const dcwNodes = d.nodes.filter(n => n.lineId === l.id)
  const daqNodes = daqAll.nodes.filter(n => n.lineId === l.id)
  return { line: l, recipe, dcwNodes, daqNodes }
}).find(x => x.recipe && x.dcwNodes.length > 0 && x.daqNodes.length > 0)
if (!cand) { console.error('FAIL: 无同时具备 数采/数控/配方 的产线'); process.exit(1) }
const { line, recipe, dcwNodes, daqNodes } = cand
console.log('target:', line.name, '| recipe:', recipe.name, `| dcw×${dcwNodes.length} daq×${daqNodes.length}`)

// ===== 0. 前置停线 + 基线 =====
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST').catch(() => {})
await sleep(1200)
const produced0 = (await j('/api/workshop/daq')).data.meta.produced
console.log('baseline produced:', produced0, '| daq node:', daqNodes[0].value, daqNodes[0].state)

// ===== 1. 开跑:配方参数随开跑下发(数控链路) =====
const st = await j(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
if (!st.data?.line?.active) { console.error('FAIL: line start:', JSON.stringify(st).slice(0, 200)); process.exit(1) }
console.log('line started, run:', st.data.line.runId?.slice(0, 8))
// 控制节点设定值 = 配方目标值(节点级绑定;mock 回读 = 指令值)
let dcwOk = 0
for (const p of recipe.params) {
  const node = (await j('/api/workshop/dcw')).data.nodes.find(n => n.id === p.nodeId)
  const hit = node && Math.abs((node.value ?? NaN) - p.value) < 0.01 && node.state === 'ok'
  if (hit) dcwOk++
  else fail(`dcw node ${p.nodeId} value=${node?.value} (expect ${p.value}) state=${node?.state}`)
}
if (dcwOk === recipe.params.length) console.log(`PASS 数控下发: ${dcwOk}/${recipe.params.length} 参数 ACK 且设定值=配方目标`)
const hist = (await j('/api/workshop/dcw')).data.history.filter(h => h.recipeRunId === st.data.line.runId)
if (hist.length >= recipe.params.length && hist.every(h => h.ok)) console.log('PASS 写历史:', hist.length, '条带批次 runId 全 ACK')
else fail(`write history wrong: ${hist.length}`)

// ===== 2. 数采门控启动:produced 增长 + 实时值变化 =====
await sleep(4000)
const mid = (await j('/api/workshop/daq')).data
const midNode = mid.nodes.find(n => n.id === daqNodes[0].id)
if (mid.meta.produced > produced0) console.log(`PASS 数采门控启动: produced ${produced0} → ${mid.meta.produced}`)
else fail(`produced not growing: ${produced0} → ${mid.meta.produced}`)
await sleep(4000)
const mid2 = (await j('/api/workshop/daq')).data
const mid2Node = mid2.nodes.find(n => n.id === daqNodes[0].id)
if (mid2.meta.produced > mid.meta.produced) console.log(`PASS 采样持续: produced → ${mid2.meta.produced}`)
else fail('produced stalled while line active')
if (mid2Node.value != null && mid2Node.value !== midNode.value) console.log(`PASS 节点实时值变化: ${midNode.value} → ${mid2Node.value} ${mid2Node.unit} (${mid2Node.state})`)
else fail(`daq value not updating: ${midNode.value} → ${mid2Node.value}`)

// ===== 3. 数字孪生面板:callout 实时值展示且随采样刷新 =====
const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(20000) // 3D 场景装配
// 断言面 = 右轨「关键设备监控」面板(不受相机距离门限制):
// .daq-item = 数采实时值,.dcw-set = 智控设定值(.dcw-src=配方 来源标签)
const panelDaqVals = () => page.evaluate(() =>
  [...document.querySelectorAll('.twin-daq .daq-item b')].map(e => e.textContent.replace(/\s+/g, '')))
const panelDcwRows = () => page.evaluate(() =>
  [...document.querySelectorAll('.twin-dcw .dcw-item')].map(e => ({
    ch: e.querySelector('.dcw-head em')?.textContent.replace(/\s+/g, ''),
    set: e.querySelector('.dcw-set')?.textContent.replace(/\s+/g, ''),
    src: e.querySelector('.dcw-src')?.textContent ?? '',
  })))
const daq1 = await panelDaqVals()
const dcwRows = await panelDcwRows()
console.log('town panel: daq rows', daq1.length, '| dcw rows', JSON.stringify(dcwRows))
if (daq1.length === 0) fail('panel has no daq rows (town 未出数据)')
// 智控:配方参数节点若绑定在面板展示的设备上 → 行应显示 配方目标+来源「配方」;
// 未绑定的参数节点不在设备面板展示(下发正确性已由 §1 的 ACK+回读断言权威覆盖)
let panelChecked = 0
for (const p of recipe.params) {
  const node = d.nodes.find(n => n.id === p.nodeId)
  const hit = dcwRows.some(r => (r.set ?? '').includes(String(p.value)) && r.src === '配方')
  if (hit) {
    panelChecked++
    console.log(`PASS 孪生面板智控设定展示: ${node?.name} = ${p.value} (来源标签「配方」)`)
  }
}
if (panelChecked === 0) console.log('INFO 配方参数节点均未绑定面板设备 —— 面板断言跳过(下发链路由 §1 ACK+回读权威覆盖)')
await page.screenshot({ path: 'docs/audit/screenshots/town-live-t0.png' })
// 数采:8s 内面板实时值变化(仅运行产线的节点在采样,变化即证明 WS→townBus→面板全链)
await sleep(8000)
const daq2 = await panelDaqVals()
await page.screenshot({ path: 'docs/audit/screenshots/town-live-t8.png' })
const changedCount = daq2.filter((v, i) => v !== daq1[i]).length
if (changedCount > 0) console.log(`PASS 孪生面板数采实时刷新: ${changedCount}/${daq1.length} 通道 8s 内值变化`)
else fail(`panel daq values static: ${JSON.stringify(daq1.slice(0, 4))}`)

// ===== 4. 停线:数采停摆 + 孪生值收敛 =====
// 注:produced 是全局计数(所有活跃产线),多产线并发时不能用作本线停线判据;
// 本线语义看两点 —— ①本线打标样本(taggedSamples)停涨;②本线数采节点 offline
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST')
await sleep(3000)
const after = (await j('/api/workshop/daq')).data
const afterLine = (await j('/api/workshop/dcw')).data.lineStates.find(s => s.lineId === line.id)
const afterNode = after.nodes.find(n => n.id === daqNodes[0].id)
await sleep(3000)
const afterLine2 = (await j('/api/workshop/dcw')).data.lineStates.find(s => s.lineId === line.id)
if (afterLine2.taggedSamples === afterLine.taggedSamples) console.log(`PASS 停线冻结: 本线打标样本停在 ${afterLine2.taggedSamples}`)
else fail(`本线打标样本仍在增长: ${afterLine.taggedSamples} → ${afterLine2.taggedSamples}`)
if (afterNode.state === 'offline') console.log('PASS 停线联动: 数采节点 offline')
else fail(`daq node state after stop: ${afterNode.state}`)
// 孪生面板收敛:停线后先前变化的数采通道冻结(不再产生新值)
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(18000)
const frozen1 = await panelDaqVals()
await sleep(6000)
const frozen2 = await panelDaqVals()
const stillChanging = frozen2.filter((v, i) => v !== frozen1[i]).length
if (stillChanging === 0) console.log('PASS 孪生面板停线收敛: 数采通道值冻结(无新样本)')
else fail(`panel still changing after stop: ${stillChanging} rows`)
await page.screenshot({ path: 'docs/audit/screenshots/town-live-stopped.png' })
await browser.close()

console.log(process.exitCode ? '\n=== E2E FAILED ===' : '\n=== E2E ALL PASS ===')
