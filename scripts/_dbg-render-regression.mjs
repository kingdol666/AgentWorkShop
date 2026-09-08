/** 渲染优化功能回归:/daq 行渲染与交互、/daq/[id] 详情、/town 场景与模型预览、全局 smoke。
 *  用法:node scripts/_dbg-render-regression.mjs [base] [email] [pass] */
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const ROOT = process.argv[2] ?? 'http://127.0.0.1:3001'
const EMAIL = process.argv[3] ?? 'perf-runner@awshop.io'
const PASS = process.argv[4] ?? 'Perf@Run2026'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ' —— ' + detail : ''}`)
}

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) }).then(r => r.json())
if (!login?.data?.token) { console.error('LOGIN FAIL'); process.exit(1) }
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: new URL(ROOT).hostname, path: '/' })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)))

// ---------- 1. /daq 行渲染完整性 ----------
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(12000)
const daqStruct = await page.evaluate(() => {
  const rows = document.querySelectorAll('.nodes-table tbody tr')
  const polylines = document.querySelectorAll('.nodes-table svg polyline')
  const limLines = document.querySelectorAll('.nodes-table svg line.lim')
  const pills = document.querySelectorAll('.nodes-table .st-pill')
  const valCells = [...document.querySelectorAll('.nodes-table .val')].slice(0, 5).map(c => c.textContent.trim())
  const toggles = document.querySelectorAll('.nodes-table .node-toggle')
  const links = document.querySelectorAll('.nodes-table .console-link')
  const lineSelects = document.querySelectorAll('.nodes-table .line-sel:not(.dev-add)')
  return { rows: rows.length, polylines: polylines.length, limLines: limLines.length, pills: pills.length, valCells, toggles: toggles.length, links: links.length, lineSelects: lineSelects.length }
})
ok('/daq 行数 227', daqStruct.rows === 227, `rows=${daqStruct.rows}`)
ok('/daq 每行趋势折线', daqStruct.polylines === 227, `polylines=${daqStruct.polylines}`)
ok('/daq 状态 pill 齐全', daqStruct.pills >= 227, `pills=${daqStruct.pills}`)
ok('/daq 启停按钮齐全', daqStruct.toggles === 227, `toggles=${daqStruct.toggles}`)
ok('/daq 控制台链接齐全', daqStruct.links === 227, `links=${daqStruct.links}`)
ok('/daq 产线下拉齐全', daqStruct.lineSelects === 227, `selects=${daqStruct.lineSelects}`)
ok('/daq 值列有数据', daqStruct.valCells.some(v => /\d/.test(v)), daqStruct.valCells[0])

// ---------- 2. WS 实时收敛:值列随读数帧变化(优化后合批仍须驱动行更新) ----------
const valChanges = await page.evaluate(() => new Promise((resolve) => {
  const cells = [...document.querySelectorAll('.nodes-table .val')]
  const texts = cells.map(c => c.textContent.trim())
  setTimeout(() => {
    const now = cells.map(c => c.textContent.trim())
    let changed = 0
    for (let i = 0; i < texts.length; i++) if (now[i] !== texts[i]) changed++
    resolve(changed)
  }, 8000)
}))
ok('/daq WS 读数驱动行更新(8s 内 ≥5 行变化)', valChanges >= 5, `changedRows=${valChanges}`)

// ---------- 3. 筛选交互(行组件随筛选增减) ----------
await page.type('.nodes-search input, input[placeholder]', '压力', { delay: 30 }).catch(() => {})
await sleep(1500)
const searchFiltered = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
ok('/daq 搜索筛选生效', searchFiltered > 0 && searchFiltered < 227, `rows=${searchFiltered}`)
await page.evaluate(() => { location.hash = '' })
// 清空搜索(全选删除)
await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace')
await sleep(1200)
const afterClear = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
ok('/daq 清空搜索恢复全量', afterClear === 227, `rows=${afterClear}`)

// ---------- 4. /daq/[id] 详情页(由行内控制台链接进入) ----------
const detailHref = await page.evaluate(() => document.querySelector('.nodes-table .console-link')?.getAttribute('href'))
await page.goto(`${ROOT}${detailHref}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(6000)
const detail = await page.evaluate(() => ({
  bigVal: document.querySelector('.big-val')?.textContent?.trim() ?? '',
  liveCanvas: !!document.querySelector('.live-canvas'),
  histCanvas: !!document.querySelector('.hist-canvas'),
  facts: document.querySelectorAll('.facts div').length,
}))
ok('/daq/[id] 大值卡渲染', /\d/.test(detail.bigVal), detail.bigVal.slice(0, 30))
ok('/daq/[id] live 趋势画布存在', detail.liveCanvas)
ok('/daq/[id] 历史画布存在', detail.histCanvas)
ok('/daq/[id] 参数事实表渲染', detail.facts >= 5, `facts=${detail.facts}`)

// ---------- 5. /town 场景 + 仪表化 + 模型预览 ----------
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(18000)
const town1 = await page.evaluate(() => ({
  canvas: !!document.querySelector('#town-host canvas'),
  stats: window.__townStats ? { ...window.__townStats } : null,
}))
ok('/town 3D 画布挂载', town1.canvas)
ok('/town 仪表化 __townStats 存在', !!town1.stats)
ok('/town 场景实体(Agent/设备)', !!town1.stats && town1.stats.agents >= 12 && town1.stats.devices >= 30, `agents=${town1.stats?.agents} devices=${town1.stats?.devices}`)
ok('/town 帧率 > 0(墙钟)', !!town1.stats && town1.stats.fps > 0, `fps=${town1.stats?.fps} rafHz=${town1.stats?.rafHz}`)
ok('/town 60fps 预算生效', !!town1.stats && town1.stats.frameBudgetMs === 16.67, `frameBudgetMs=${town1.stats?.frameBudgetMs}`)
const town2 = await page.evaluate(() => new Promise((resolve) => {
  const s0 = JSON.stringify(window.__townStats)
  setTimeout(() => resolve({ s0, s1: JSON.stringify(window.__townStats) }), 3000)
}))
ok('/town 仪表化持续更新', town2.s0 !== town2.s1)

// 打开模型库抽屉(若存在入口按钮)→ 预览卡渲染不崩
const libOpened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button, .hud-btn, [class*="lib"]')].find(b => /模型/.test(b.textContent ?? ''))
  if (btn) { btn.click(); return true }
  return false
})
if (libOpened) {
  await sleep(4000)
  const previews = await page.evaluate(() => document.querySelectorAll('.model-preview-3d canvas').length)
  ok('/town 模型库打开且预览卡有画布', previews > 0, `previews=${previews}`)
}
await page.screenshot({ path: '.e2e-shots/regression-town.png' })

// ---------- 6. 全局页面 smoke(200 + 无 pageerror) ----------
for (const path of ['/workshop', '/dcw', '/logs', '/monitor', '/settings', '/users', '/permissions']) {
  const resp = await page.goto(`${ROOT}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).then(r => r.status()).catch(() => 0)
  await sleep(1500)
  ok(`smoke ${path}`, resp === 200, `status=${resp}`)
}

ok('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
const failed = results.filter(r => !r.pass)
writeFileSync('.e2e-shots/render-regression.json', JSON.stringify({ at: new Date().toISOString(), base: ROOT, passed: results.length - failed.length, failed: failed.length, results }, null, 2))
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====${failed.length ? ' FAILED: ' + failed.map(f => f.name).join(', ') : ''}`)
await browser.close()
process.exit(failed.length ? 1 : 0)
