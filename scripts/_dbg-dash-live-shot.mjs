/** 一次性:开跑产线后的大屏活体截图(趋势线/吞吐条/样本计数增长) */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const d = (await j('/api/workshop/dcw')).data
const line = d.lines.find((l) => d.recipes.some(r => r.lineId === l.id && r.params.length > 0))
const recipe = d.recipes.find(r => r.lineId === line.id && r.params.length > 0)
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST').catch(() => {})
const st = await j(`/api/workshop/dcw/lines/${line.id}/start`, 'POST', { recipeId: recipe.id })
if (!st.data?.line?.active) { console.error('start failed'); process.exit(1) }
console.log('line started:', line.name, recipe.name)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=2560,1400'],
})
const page = await browser.newPage()
await page.setViewport({ width: 2560, height: 1400 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/`, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 50000)) // 攒 10 拍趋势点
const live = await page.evaluate(() => ({
  kpi: [...document.querySelectorAll('.kpi-value')].map(k => k.textContent?.trim()),
  trendLegend: [...document.querySelectorAll('.dpanel')][0]?.textContent?.slice(0, 120),
  samples: [...document.querySelectorAll('.kpi')].map(k => k.textContent)?.[3],
}))
console.log(JSON.stringify(live, null, 1))
await page.screenshot({ path: 'docs/audit/screenshots/dashboard-bigscreen-live.png' })
await j(`/api/workshop/dcw/lines/${line.id}/stop`, 'POST')
console.log('line stopped (env restored)')
await browser.close()
