/** 最终回归:点击响应延迟(点击→DOM 生效)+ 筛选/手风琴交互 + 运行时错误。 */
import puppeteer from 'puppeteer-core'

const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
// 就绪等待:表格行数 > 0(重编译/慢加载窗口最多等 40s)
let rows = 0
for (let i = 0; i < 20; i++) {
  await sleep(2000)
  rows = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
  if (rows > 0) break
}
console.log('渲染行数:', rows)
if (!rows) fail('表格未渲染')

// 点击响应:切模板筛选 → count 变化的耗时
const lat = await page.evaluate(() => new Promise((resolve) => {
  const sels = [...document.querySelectorAll('.tbl-toolbar select')]
  const s = sels.find(x => x.options[0]?.textContent.includes('全部模板'))
  const before = document.querySelector('.tbl-toolbar .count')?.textContent.trim()
  const t0 = performance.now()
  s.value = s.options[1].value
  s.dispatchEvent(new Event('change'))
  const check = () => {
    const now = document.querySelector('.tbl-toolbar .count')?.textContent.trim()
    if (now !== before) resolve(Math.round(performance.now() - t0))
    else if (performance.now() - t0 > 3000) resolve(-1)
    else setTimeout(check, 30)
  }
  setTimeout(check, 30)
}))
console.log('模板筛选点击→生效延迟:', lat, lat >= 0 && lat < 500 ? 'PASS' : 'FAIL')
await page.evaluate(() => {
  const s = [...document.querySelectorAll('.tbl-toolbar select')].find(x => x.options[0]?.textContent.includes('全部模板'))
  s.value = ''
  s.dispatchEvent(new Event('change'))
})

// 手风琴开合响应
const acc = await page.evaluate(() => new Promise((resolve) => {
  const t0 = performance.now()
  document.querySelector('.opt-head').click()
  const check = () => {
    const h = document.querySelector('.opt-body')?.getBoundingClientRect().height ?? 0
    if (h > 100) resolve(Math.round(performance.now() - t0))
    else if (performance.now() - t0 > 3000) resolve(-1)
    else requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}))
console.log('优化记录展开延迟:', acc, acc >= 0 && acc < 600 ? 'PASS' : 'FAIL')

// 连续快速点击 10 次(压力:交互不被长任务饿死)
const spam = await page.evaluate(async () => {
  const btn = document.querySelector('.opt-head')
  const t0 = performance.now()
  for (let i = 0; i < 10; i++) {
    btn.click()
    await new Promise(r => setTimeout(r, 60))
  }
  const settled = document.querySelector('.opt-body')?.getBoundingClientRect().height ?? 0
  return { ms: Math.round(performance.now() - t0), h: Math.round(settled) }
})
console.log('连点 10 次:', JSON.stringify(spam), '(应无卡死,终态为开或合)')
console.log('pageerror:', errors.length ? errors : 'none')
if (errors.some(e => e.includes('dcwTimer'))) fail('dcwTimer 错误仍存在')
await browser.close()
console.log(process.exitCode ? 'REGRESSION FAILED' : 'ALL PASS')
