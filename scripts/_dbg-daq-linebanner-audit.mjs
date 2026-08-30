/**
 * 一次性审计:/daq 产线上下文横幅 + 产线列运行注记。
 * ①未筛选 → 全局门控横幅;②筛选待机产线 → 未开跑横幅 + 直达产线管理,行注记"待机";
 * ③开跑该产线 → 绿色横幅(产品/Recipe/批次),行注记"运行中 产品 · Recipe";
 * 结束停线还原环境。
 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const d = (await j('/api/workshop/dcw')).data
const target = d.lines.find(l => d.nodes.some(n => n.lineId === l.id) && d.recipes.some(r => r.lineId === l.id && r.params.length > 0))
if (!target) { console.error('FAIL: 没有带节点+配方的产线可验'); process.exit(1) }
const recipe = d.recipes.find(r => r.lineId === target.id && r.params.length > 0)
console.log('target line:', target.name, '| recipe:', recipe.name)

// 前置:确保该产线未在跑
await j(`/api/workshop/dcw/lines/${target.id}/stop`, 'POST').catch(() => {})

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1280'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1280 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const selectLine = () => page.evaluate((lineName) => {
  const sel = document.querySelectorAll('.tbl-toolbar .inp-sel')[0]
  const opt = [...sel.options].find(o => o.textContent.trim() === lineName)
  if (!opt) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}, target.name)
const bannerText = () => page.evaluate(() => {
  const banners = [...document.querySelectorAll('.infra-banner')]
  return banners.map(b => ({ good: b.classList.contains('good'), text: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 180) }))
})

// ===== 1. 未筛选:全局门控横幅 =====
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(4000)
const b0 = await bannerText()
console.log('unfiltered banners:', JSON.stringify(b0))
if (b0.some(b => b.text.includes('产线未开跑'))) console.log('PASS global gate banner (unfiltered)')
else fail('global banner missing when unfiltered')

// ===== 2. 筛选待机产线:未开跑横幅 + 直达按钮,行注记 待机 =====
if (!await selectLine()) { fail('cannot select target line'); await browser.close(); process.exit(1) }
await sleep(600)
const b1 = await bannerText()
const noteIdle = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.nodes-table tbody tr')].find(r => r.querySelector('.line-run'))
  return row?.querySelector('.line-run')?.textContent.replace(/\s+/g, ' ').trim()
})
console.log('idle-line banner:', JSON.stringify(b1), '| row note:', noteIdle)
const idleBanner = b1.find(b => b.text.includes(target.name))
if (idleBanner && !idleBanner.good && idleBanner.text.includes('未开跑') && idleBanner.text.includes('暂停采集')) {
  console.log('PASS idle-line banner: 未开跑提示')
} else fail(`idle banner wrong: ${JSON.stringify(idleBanner)}`)
const idleLink = await page.evaluate(() => document.querySelector('.infra-banner .pill-btn')?.getAttribute('href'))
if (idleLink === `/dcw/${target.id}`) console.log('PASS jump link → /dcw/{lineId}:', idleLink)
else fail(`jump link wrong: ${idleLink}`)
if (noteIdle === '未运行') console.log('PASS row note 未运行 (idle)')
else fail(`row note wrong: ${noteIdle}`)
await page.screenshot({ path: 'docs/audit/screenshots/daq-linebanner-idle.png' })

// ===== 3. 开跑:绿色横幅(产品/Recipe) + 行注记 运行中 产品 · Recipe =====
const st = await j(`/api/workshop/dcw/lines/${target.id}/start`, 'POST', { recipeId: recipe.id })
if (!st.data?.line?.active) { fail(`line start failed: ${JSON.stringify(st).slice(0, 160)}`); await browser.close(); process.exit(1) }
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(4000)
if (!await selectLine()) { fail('cannot re-select line after reload'); await browser.close(); process.exit(1) }
await sleep(600)
const b2 = await bannerText()
const noteRun = await page.evaluate(() => {
  const notes = [...document.querySelectorAll('.nodes-table tbody .line-run')].map(n => n.textContent.replace(/\s+/g, ' ').trim())
  return { on: notes.filter(s => s.includes('运行中')).length, idle: notes.filter(s => s === '待机').length, sample: notes[0] }
})
console.log('running banner:', JSON.stringify(b2), '| row notes:', JSON.stringify(noteRun))
const runBanner = b2.find(b => b.good)
if (runBanner && runBanner.text.includes('运行中') && runBanner.text.includes(recipe.name)) {
  console.log('PASS running banner (good variant, recipe shown)')
} else fail(`running banner wrong: ${JSON.stringify(runBanner)}`)
if ((noteRun.on ?? 0) > 0 && (noteRun.sample ?? '').includes(recipe.name)) {
  console.log('PASS row notes 运行中 + 产品/Recipe')
} else fail(`row notes wrong: ${JSON.stringify(noteRun)}`)
await page.screenshot({ path: 'docs/audit/screenshots/daq-linebanner-running.png' })

// ===== 4. 停线还原 =====
await j(`/api/workshop/dcw/lines/${target.id}/stop`, 'POST')
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(3500)
await selectLine()
await sleep(600)
const b3 = await bannerText()
if (b3.some(b => !b.good && b.text.includes('未开跑'))) console.log('PASS restored: idle banner back after stop')
else fail(`restore wrong: ${JSON.stringify(b3)}`)
await browser.close()
console.log(process.exitCode ? '\n=== AUDIT FAILED ===' : '\n=== ALL PASS ===')
