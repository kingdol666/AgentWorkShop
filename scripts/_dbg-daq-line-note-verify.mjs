/** 一次性:验证数采面板节点列表的产线运行注记(未运行/运行中+产品·Recipe) */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const d = (await j('/api/workshop/dcw')).data
const line = d.lines.find(l => l.name === '1号产线') ?? d.lines.find(l => d.recipes.some(r => r.lineId === l.id && r.params.length > 0))
const recipe = d.recipes.find(r => r.lineId === line.id && r.params.length > 0)
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST').catch(() => {})

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=2560,1400'],
})
const page = await browser.newPage()
await page.setViewport({ width: 2560, height: 1400 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

// ① 未开跑:列表应显示「未运行」
await page.goto(`${ROOT}/daq`, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 5000))
await page.evaluate((lineName) => {
  const sel = document.querySelectorAll('.tbl-toolbar .inp-sel')[0]
  const opt = [...sel.options].find(o => o.textContent.trim() === lineName)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}, line.name)
await new Promise(r => setTimeout(r, 600))
const idleNotes = await page.evaluate(() =>
  [...document.querySelectorAll('.nodes-table .line-run')].map(n => ({ text: n.textContent.replace(/\s+/g, ' ').trim(), on: n.classList.contains('on') })))
console.log('① 未开跑 注记:', JSON.stringify(idleNotes))
await page.screenshot({ path: 'docs/audit/screenshots/daq-line-note-idle.png' })

// ② 开跑:列表应显示「运行中 + 产品 · Recipe」
const st = await j(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
if (!st.data?.line?.active) { console.error('start failed'); process.exit(1) }
await page.reload({ waitUntil: 'networkidle2' })
await new Promise(r => setTimeout(r, 5000))
await page.evaluate((lineName) => {
  const sel = document.querySelectorAll('.tbl-toolbar .inp-sel')[0]
  const opt = [...sel.options].find(o => o.textContent.trim() === lineName)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}, line.name)
await new Promise(r => setTimeout(r, 600))
const runNotes = await page.evaluate(() =>
  [...document.querySelectorAll('.nodes-table .line-run')].map(n => ({ text: n.textContent.replace(/\s+/g, ' ').trim(), on: n.classList.contains('on') })))
console.log('② 开跑后 注记:', JSON.stringify(runNotes))
const okRun = runNotes.length > 0 && runNotes.every(n => n.on && n.text.includes('运行中') && n.text.includes('·'))
console.log(okRun ? 'PASS: 列表运行注记 = 运行中 + 产品 · Recipe' : 'FAIL: 注记不符')
await page.screenshot({ path: 'docs/audit/screenshots/daq-line-note-running.png' })

await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST')
console.log('line stopped (env restored)')
await browser.close()
