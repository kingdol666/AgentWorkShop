/** 一次性:越限实时警告验证 v2 —— 正常量程节点 + 不可达配方监控窗(开跑后值恒低于窗下限) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const rand = Math.random().toString(36).slice(2, 6)
const jpost = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())

// 夹具:产线 + 数控节点(开跑需参数)+ 数采节点(正常量程 150~185,值 ~168)
const line = (await jpost('/api/workshop/dcw/lines', { name: `警告验证线-${rand}` })).data.line
const dcwNode = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: `警告验证设定-${rand}`, lineId: line.id })).data.node
const daqNode = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `警告验证采集-${rand}`, lineId: line.id, intervalMs: 500 })).data.node
const product = (await jpost('/api/workshop/dcw/products', { lineId: line.id, name: `警告验证产品-${rand}` })).data.product
const recipe = (await jpost('/api/workshop/dcw/recipes', { productId: product.id, name: `警告验证配方-${rand}`, params: [{ nodeId: dcwNode.id, value: 175 }], daqWindows: [{ nodeId: daqNode.id, min: 178, max: 182 }] })).data.recipe
const start = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id })
console.log('fixture:', daqNode?.id ?? 'FAIL', '| lineStart:', start.code === 0 ? 'OK' : JSON.stringify(start).slice(0, 100))

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 120)))
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 9000))

let warn = null
for (let i = 0; i < 10; i++) {
  warn = await page.evaluate(() => {
    const el = document.querySelector('.live-warn')
    return el ? el.textContent?.replace(/\s+/g, ' ').slice(0, 140) : null
  })
  if (warn) break
  await new Promise(r => setTimeout(r, 1000))
}
console.log(`越限警告条: ${warn ? `PASS "${warn}"` : 'FAIL(未出现)'}`)

const redRow = await page.evaluate(() => !!document.querySelector('.row-recipe-alarm'))
console.log(`越限行标红: ${redRow ? 'PASS' : 'FAIL'}`)

await page.evaluate(() => document.querySelector('.live-warns')?.scrollIntoView({ block: 'center' }))
await new Promise(r => setTimeout(r, 400))
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/daq-warn.png' })
await browser.close()
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors')
