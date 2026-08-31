/** 视觉验收:运行态中文截图 + 英文列头截图(行级状态机上线后表格观感) */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ut-ffc1dfbbc0c1444c87c1ec69a9e8208c`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 选有配方+数采节点的产线并开跑
const d = (await j('/api/workshop/dcw')).data
const daqAll = (await j('/api/workshop/daq')).data
const cand = d.lines.map((l) => {
  const recipe = d.recipes.find(r => r.lineId === l.id && r.params.length > 0 && r.params.every(p => p.nodeId))
  return { line: l, recipe, n: daqAll.nodes.filter(x => x.lineId === l.id).length }
}).find(x => x.recipe && x.n > 0)
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
await sleep(1200)
const st = await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
console.log('started:', st.data?.line?.active, st.data?.line?.productName)

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(6500)
await page.screenshot({ path: 'docs/audit/screenshots/daq-rowstate-zh.png' })

// EN 列头
await page.evaluate(() => localStorage.setItem('aw.locale', 'en'))
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(6000)
await page.screenshot({ path: 'docs/audit/screenshots/daq-rowstate-en.png' })
const enHead = await page.evaluate(() => [...document.querySelectorAll('.nodes-table thead th')].map(th => th.textContent.trim()))
console.log('EN columns:', enHead.join(' | '))
await browser.close()
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST')
console.log('stopped (环境还原)')
