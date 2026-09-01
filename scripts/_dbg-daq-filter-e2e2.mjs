/** /daq 交互实测 v2:网络监听版(避免 resource timing 缓冲溢出)。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }

const login = await fetch(`${ROOT}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
const optRequests = []
page.on('request', (r) => {
  if (r.url().includes('/dcw/optimizations'))
    optRequests.push(r.url())
})
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(7000)

// ---- 1. 优化记录预取 ----
if (optRequests.length === 0) fail('进页后未预取优化记录')
else console.log('PASS 优化记录进页预取:点击面板前已请求', optRequests[0].split('/api')[1])
await page.click('.opt-head')
await sleep(400)
const optRows = await page.evaluate(() => document.querySelectorAll('.opt-list .opt-row').length)
if (optRows > 0) console.log(`PASS 面板展开即渲染 ${optRows} 条记录`)
else fail('面板展开后无记录')

// ---- 2. Recipe 筛选 ----
const hasRecipes = await page.evaluate(() => document.querySelectorAll('.opt-filters select')[1]?.options.length ?? 0)
if (hasRecipes > 1) {
  const before = optRequests.length
  await page.evaluate(() => {
    const sel = document.querySelectorAll('.opt-filters select')[1]
    sel.value = sel.options[1].value
    sel.dispatchEvent(new Event('change'))
  })
  await sleep(1500)
  const hit = optRequests.slice(before).find(u => u.includes('recipeId='))
  if (hit) {
    console.log('PASS Recipe 筛选:请求', hit.split('/api')[1])
    const rows2 = await page.evaluate(() => document.querySelectorAll('.opt-list .opt-row').length)
    console.log(`  └ Recipe 过滤后记录数: ${rows2}(含空态即 0)`)
  }
  else fail(`Recipe 筛选未发起带 recipeId 的请求(新增请求: ${JSON.stringify(optRequests.slice(before))})`)
}
else console.log('SKIP Recipe 筛选:当前库中无配方,下拉只有「全部」')

await page.click('.clear-btn').catch(() => {})
await page.evaluate(() => { const s = document.querySelector('.flt-search'); if (s) s.value = '' }).catch(() => {})
await browser.close()
console.log(process.exitCode ? 'E2E FAILED' : 'ALL PASS')
