/** 三节拍独立性的功能验证(生产 3001):
 *  1) 通过设置 API 分别改「采集/WS下发/趋势刷新」缺省与下限 → 网关状态各自独立生效;
 *  2) 数采列表「采样周期/WS 下发」两列显示随各自缺省变化(互不牵连);
 *  3) 数采详情页趋势图按 displayIntervalMs 自动重拉(按网络请求计数验证节拍);
 *  4) 复原并确认回落到原值。 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const EMAIL = 'zhangwei@awshop.io'
const PASS = 'Awshop@123'
const T = (k, v) => ({ [k]: v })

const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) }).then(r => r.json())
const token = login.data.token
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const j = async (p, init) => (await fetch(BASE + p, init)).json()

let fail = 0
const check = (n, ok, extra = '') => { console.log(`${ok ? '✔' : '✖'} ${n}${extra ? ` — ${extra}` : ''}`); if (!ok) fail++ }

const patch = o => j('/api/system/settings', { method: 'PATCH', headers: H, body: JSON.stringify({ override: o }) })
const ctrl = async () => (await j('/api/workshop/daq', { headers: H })).data.controller

// ---------- 1) 三节拍独立热生效 ----------
const before = await ctrl()
console.log('origin:', JSON.stringify({ s: before.defaultIntervalMs, p: before.defaultPublishIntervalMs, q: before.queryDisplayIntervalMs }))
await patch({ 'daq.sampling.defaultIntervalMs': 3000, 'daq.publish.defaultIntervalMs': 1000, 'daq.query.displayIntervalMs': 2000 })
await new Promise(r => setTimeout(r, 1200))
const after = await ctrl()
check('采集缺省 → 3000(独立生效)', after.defaultIntervalMs === 3000, `s=${after.defaultIntervalMs}`)
check('WS 下发缺省 → 1000(不受采集改动牵连)', after.defaultPublishIntervalMs === 1000, `p=${after.defaultPublishIntervalMs}`)
check('趋势刷新缺省 → 2000(独立生效)', after.queryDisplayIntervalMs === 2000, `q=${after.queryDisplayIntervalMs}`)

// 只改下限,不动缺省 → 缺省应被下限抬升/保持,且三者互不牵连
await patch({ 'daq.publish.minIntervalMs': 200, 'daq.sampling.minIntervalMs': 1500, 'daq.query.minDisplayIntervalMs': 800 })
await new Promise(r => setTimeout(r, 1200))
const c2 = await ctrl()
check('WS 下限 → 200', c2.minPublishIntervalMs === 200, `minPublish=${c2.minPublishIntervalMs}`)
check('采集下限 → 1500', c2.minIntervalMs === 1500, `minInterval=${c2.minIntervalMs}`)
check('趋势刷新下限 → 800', c2.minQueryDisplayIntervalMs === 800, `minDisplay=${c2.minQueryDisplayIntervalMs}`)
check('下限变更不影响各自缺省(采样仍 3000 / 刷新仍 2000)', c2.defaultIntervalMs === 3000 && c2.queryDisplayIntervalMs === 2000, `${c2.defaultIntervalMs}/${c2.queryDisplayIntervalMs}`)

// 超出下限的写入应被服务端钳制:采集 500 < 下限 1500 → 拒绝/钳制
await patch({ 'daq.sampling.defaultIntervalMs': 500 })
await new Promise(r => setTimeout(r, 1000))
const c3 = await ctrl()
check('采集缺省低于下限时不会生效(钳制保护)', c3.defaultIntervalMs >= 1500, `s=${c3.defaultIntervalMs}`)

// ---------- 2) 列表两列各自显示 ----------
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1760,1100'] })
const page = await browser.newPage()
await page.setViewport({ width: 1760, height: 1100 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForFunction(() => document.querySelectorAll('.nodes-table tbody tr td b').length > 3, { timeout: 60000 })
await new Promise(r => setTimeout(r, 2500))
const cols = await page.evaluate(() => {
  const row = document.querySelector('.nodes-table tbody tr')
  const tds = [...row.querySelectorAll('td')]
  return { interval: tds[4]?.innerText?.trim(), publish: tds[5]?.innerText?.trim() }
})
console.log('list cols:', JSON.stringify(cols))
const live = await ctrl()
check(`列表「采样周期」列反映缺省 ${live.defaultIntervalMs}ms`, (cols.interval || '').includes(String(live.defaultIntervalMs)), cols.interval)
check(`列表「WS 下发」列反映缺省 ${live.defaultPublishIntervalMs}ms`, (cols.publish || '').includes(String(live.defaultPublishIntervalMs)), cols.publish)
await page.screenshot({ path: '.e2e-shots/prod-intervals-list.png' })

// ---------- 3) 详情页按 displayIntervalMs 自动重拉 ----------
const firstNode = await page.evaluate(() => document.querySelector('.nodes-table tbody tr a')?.getAttribute('href') ?? '')
const nodeHref = firstNode || (await j('/api/workshop/daq', { headers: H })).data.nodes.find(n => n.lineId)?.id
if (nodeHref) {
  const url = nodeHref.startsWith('/') ? BASE + nodeHref : `${BASE}/daq/${nodeHref}`
  let hits = 0
  page.on('request', (req) => { if (/\/samples/.test(req.url())) hits++ })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('.refresh-ctl input', { timeout: 60000 })
  await new Promise(r => setTimeout(r, 2000))
  hits = 0
  await new Promise(r => setTimeout(r, 12000))
  const expected = Math.round(12000 / 2000)
  console.log(`detail /samples requests in 12s = ${hits} (displayIntervalMs=2000 → ~${expected})`)
  check('详情页按趋势刷新间隔自动拉取时序库', hits >= 3 && hits <= expected + 3, `hits=${hits}`)
  await page.screenshot({ path: '.e2e-shots/prod-daq-detail.png' })
}

// ---------- 4) 复原 ----------
await patch({ 'daq.sampling.defaultIntervalMs': null, 'daq.sampling.minIntervalMs': null, 'daq.publish.defaultIntervalMs': null, 'daq.publish.minIntervalMs': null, 'daq.query.displayIntervalMs': null, 'daq.query.minDisplayIntervalMs': null })
await new Promise(r => setTimeout(r, 1200))
const back = await ctrl()
check('复原后回落默认(采集 5000 / 下发 1000 / 刷新 5000)', back.defaultIntervalMs === 5000 && back.defaultPublishIntervalMs === 1000 && back.queryDisplayIntervalMs === 5000, JSON.stringify({ s: back.defaultIntervalMs, p: back.defaultPublishIntervalMs, q: back.queryDisplayIntervalMs }))

await browser.close()
console.log(fail === 0 ? '全部通过' : `失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
