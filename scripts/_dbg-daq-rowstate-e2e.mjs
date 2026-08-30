/**
 * 一次性 E2E:/daq 节点表行级状态机(产线运行列 + 产品/Recipe 列 + 状态列真实场景语义)。
 * ①停线基线:产线运行=未运行,产品/Recipe=--,状态=未运行(非故障离线),实时值置灰;
 * ②开跑:产线运行=运行中(呼吸点),产品/Recipe=活动批次,状态∈正常/预警/告警,实时值不置灰;
 * ③死驱动探针(modbus-tcp 指向拒绝连接的端口):产线运行仍=运行中,但该节点状态=离线(采不到数据),
 *   tooltip 说明「产线运行中但无新数据」—— 用户要求的核心场景;
 * ④停线:全部回到 未运行;探针节点删除还原环境。
 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PROBE_NAME = 'E2E离线探针'

// ===== 选目标产线:同时具备 数采节点 + 参数级绑定配方 =====
const d = (await j('/api/workshop/dcw')).data
const daqAll = (await j('/api/workshop/daq')).data
const cand = d.lines.map((l) => {
  const recipe = d.recipes.find(r => r.lineId === l.id && r.params.length > 0 && r.params.every(p => p.nodeId))
  const daqNodes = daqAll.nodes.filter(n => n.lineId === l.id)
  return { line: l, recipe, daqNodes }
}).find(x => x.recipe && x.daqNodes.length > 0)
if (!cand) { console.error('FAIL: 无同时具备 数采节点+配方 的产线'); process.exit(1) }
const { line, recipe, daqNodes } = cand
console.log('target:', line.name, '| recipe:', recipe.name, `| daq×${daqNodes.length}`)

// 行定位:节点表首列含 id 前 8 位(id.slice 陷阱 → 用 API id 映射行,不按行号猜)
const idp = id => id.slice(0, 8)
const rowInfo = (page, prefix) => page.evaluate((p) => {
  const rows = [...document.querySelectorAll('.nodes-table tbody tr')]
  const row = rows.find(r => r.querySelector('td .mono.dim')?.textContent.trim() === p)
  if (!row) return null
  const pill = row.querySelectorAll('td')[1]?.querySelector('.st-pill')
  const val = row.querySelectorAll('td')[2]
  const run = [...row.querySelectorAll('td')].find(td => td.querySelector('.run-pill'))
  const prod = row.querySelector('.prod-cell')
  return {
    state: pill?.textContent.trim() ?? null,
    stateCls: pill?.className ?? '',
    stateTip: pill?.getAttribute('title') ?? '',
    valStale: !!val?.classList.contains('stale'),
    runText: run?.querySelector('.run-pill')?.textContent.trim() ?? null,
    runOn: !!run?.querySelector('.run-pill.on'),
    prodText: prod?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  }
}, prefix)

// ===== 浏览器(登录 cookie) =====
const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e)))
async function gotoDaq() {
  await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000) // 水合 + REST 首拍
}

// ===== ① 停线基线 =====
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST').catch(() => {})
await sleep(1500)
await gotoDaq()
const cols = await page.evaluate(() => [...document.querySelectorAll('.nodes-table thead th')].map(th => th.textContent.trim()))
console.log('columns:', cols.join(' | '))
if (cols.includes('产线运行') && cols.includes('产品 / Recipe')) console.log('PASS 新列头: 产线运行 + 产品 / Recipe')
else fail(`新列头缺失: ${cols.join(',')}`)

const idle0 = await rowInfo(page, idp(daqNodes[0].id))
console.log('idle row:', JSON.stringify(idle0))
if (idle0?.runText === '未运行' && !idle0.runOn) console.log('PASS 停线: 产线运行列=未运行(空心点)')
else fail(`停线产线运行列: ${JSON.stringify(idle0)}`)
if (idle0?.prodText === '--') console.log('PASS 停线: 产品/Recipe=--')
else fail(`停线产品/Recipe: ${idle0?.prodText}`)
if (idle0?.state === '未运行') console.log('PASS 停线: 状态=未运行(非故障离线)')
else fail(`停线状态: ${idle0?.state}`)
if (idle0?.valStale) console.log('PASS 停线: 实时值置灰(最后值)')
else fail('停线实时值未置灰')

// ===== ② 开跑:运行中 + 产品/Recipe + 新鲜状态 =====
const st = await j(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
if (!st.data?.line?.active) { console.error('FAIL: line start:', JSON.stringify(st).slice(0, 200)); process.exit(1) }
const prodName = st.data.line.productName, rcpName = st.data.line.recipeName
console.log('line started:', prodName, '·', rcpName)
await sleep(4000)
await gotoDaq()
const run0 = await rowInfo(page, idp(daqNodes[0].id))
console.log('running row:', JSON.stringify(run0))
if (run0?.runText === '运行中' && run0.runOn) console.log('PASS 开跑: 产线运行列=运行中(呼吸绿点)')
else fail(`开跑产线运行列: ${JSON.stringify(run0)}`)
if (run0?.prodText?.includes(prodName) && run0?.prodText?.includes(rcpName)) console.log(`PASS 开跑: 产品/Recipe=${prodName} · ${rcpName}`)
else fail(`开跑产品/Recipe: ${run0?.prodText} (expect ${prodName} · ${rcpName})`)
if (['正常', '预警', '告警'].includes(run0?.state) && !run0.valStale) console.log(`PASS 开跑: 状态=${run0.state}(数据新鲜,值未置灰)`)
else fail(`开跑状态: ${JSON.stringify(run0)}`)

// ===== ③ 死驱动探针:产线运行中但采不到数据 → 离线 =====
const created = await j('/api/workshop/daq', 'POST', {
  templateRef: 'daq-temp-tc',
  name: PROBE_NAME,
  driver: 'modbus-tcp',
  driverConfig: { host: '127.0.0.1', port: 59999, unitId: 1, register: 40001, registerType: 'holding' },
  lineId: line.id,
  intervalMs: 1000,
})
const probe = created.data?.node
if (!probe?.id) { console.error('FAIL: probe create:', JSON.stringify(created).slice(0, 200)); process.exit(1) }
console.log('probe created:', idp(probe.id))
await sleep(12000) // 驱动拒连 → server 置 offline;客户端 lastAt 始终为空 → 恒判「采不到数据」
await gotoDaq()
const probeRow = await rowInfo(page, idp(probe.id))
const liveRow = await rowInfo(page, idp(daqNodes[0].id))
console.log('probe row:', JSON.stringify(probeRow))
console.log('live row :', JSON.stringify(liveRow))
if (probeRow?.runText === '运行中' && probeRow.runOn) console.log('PASS 探针: 产线仍运行(产线运行列=运行中)')
else fail(`探针产线运行列: ${JSON.stringify(probeRow)}`)
if (probeRow?.state === '离线') console.log('PASS 探针: 采不到数据 → 状态=离线')
else fail(`探针状态: ${probeRow?.state} (expect 离线)`)
if ((probeRow?.stateTip ?? '').includes('无新数据')) console.log('PASS 探针: 离线原因提示(产线运行中但无新数据)')
else fail(`探针提示: ${probeRow?.stateTip}`)
if (probeRow?.valStale) console.log('PASS 探针: 实时值置灰')
else fail('探针实时值未置灰')
if (liveRow?.state !== '离线') console.log('PASS 对照: 同线 mock 节点仍', liveRow?.state, '(探针离线是个体故障,不波及邻居)')
else fail('对照节点也被判离线(不应)')

// ===== ④ 停线 + 清理 =====
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST')
await sleep(1500)
await gotoDaq()
const idle1 = await rowInfo(page, idp(probe.id))
if (idle1?.runText === '未运行' && idle1?.state === '未运行') console.log('PASS 停线: 探针回到 未运行')
else fail(`停线探针行: ${JSON.stringify(idle1)}`)
const del = await j(`/api/workshop/daq/${probe.id}`, 'DELETE')
if (del.code === 0) console.log('cleanup: 探针节点已删除')
else fail(`cleanup failed: ${JSON.stringify(del)}`)

await page.screenshot({ path: 'docs/audit/screenshots/daq-rowstate-final.png' })
await browser.close()
if (pageErrors.length) fail(`pageerror: ${pageErrors[0]}`)
console.log(process.exitCode ? '\n=== E2E FAILED ===' : '\n=== E2E ALL PASS ===')
