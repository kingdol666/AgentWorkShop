/** 特写:筛选到运行中的 1号产线,目视验证 运行中绿点 + 产品/Recipe + 正常状态 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ut-ffc1dfbbc0c1444c87c1ec69a9e8208c`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

const d = (await j('/api/workshop/dcw')).data
const cand = d.lines.map((l) => {
  const recipe = d.recipes.find(r => r.lineId === l.id && r.params.length > 0 && r.params.every(p => p.nodeId))
  return { line: l, recipe }
}).find(x => x.recipe)
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
await sleep(1200)
await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
console.log('started:', cand.line.name)

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(6000)
// 选产线筛选
await page.select('.filters .inp-sel', cand.line.id)
await sleep(2500)
await page.screenshot({ path: 'docs/audit/screenshots/daq-rowstate-running.png', clip: { x: 220, y: 300, width: 1690, height: 760 } })
await browser.close()
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST')
console.log('stopped (环境还原)')
