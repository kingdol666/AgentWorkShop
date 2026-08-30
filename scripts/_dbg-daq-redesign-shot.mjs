/** 一次性:/daq 改版截图 —— 整页 / 产线状态带 / 筛选交互(产线筛选+运行态筛选) */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1280'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1280, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 4500))
await page.screenshot({ path: 'docs/audit/screenshots/daq-redesign-full.png', fullPage: false })

// 产线状态带特写(总控条区域)
const strip = await page.evaluate(() => {
  const el = document.querySelector('.ctrl-card')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height, text: el.textContent.replace(/\s+/g, ' ').slice(0, 300) }
})
console.log('ctrl-card:', JSON.stringify(strip?.text))
if (strip) {
  await page.evaluate((y) => { window.scrollTo(0, 0) }, strip.y)
  await new Promise(r => setTimeout(r, 300))
}

// 筛选:选第一条有节点的产线
const picked = await page.evaluate(() => {
  const sel = document.querySelectorAll('.tbl-toolbar .inp-sel')[0]
  if (!sel) return null
  const opt = [...sel.options].find(o => o.value && o.value !== 'none')
  if (!opt) return null
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return opt.textContent
})
await new Promise(r => setTimeout(r, 600))
const afterLine = await page.evaluate(() => ({
  count: document.querySelector('.tbl-toolbar .count')?.textContent.trim(),
  rows: document.querySelectorAll('.nodes-table tbody tr').length,
}))
console.log(`line filter [${picked}]:`, JSON.stringify(afterLine))
await page.screenshot({ path: 'docs/audit/screenshots/daq-redesign-filtered.png' })

// 再叠加:产线运行 = 采集关闭
await page.evaluate(() => {
  const sel = document.querySelectorAll('.tbl-toolbar .inp-sel')[2]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'off')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
await new Promise(r => setTimeout(r, 600))
const afterRun = await page.evaluate(() => ({
  count: document.querySelector('.tbl-toolbar .count')?.textContent.trim(),
  hasClear: !!document.querySelector('.clear-btn'),
}))
console.log('+lineRun=off:', JSON.stringify(afterRun))
await page.screenshot({ path: 'docs/audit/screenshots/daq-redesign-filtered2.png' })

// 清除筛选恢复
await page.evaluate(() => document.querySelector('.clear-btn')?.click())
await new Promise(r => setTimeout(r, 500))
const afterClear = await page.evaluate(() => ({
  count: document.querySelector('.tbl-toolbar .count')?.textContent.trim(),
}))
console.log('after clear:', JSON.stringify(afterClear))

console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none')

// 对照:未改动的 /dcw 页是否也有 hydration 警告(判定存量/引入)
const page2 = await browser.newPage()
await page2.setViewport({ width: 1920, height: 1280 })
await page2.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errs2 = []
page2.on('console', (m) => { if (m.type() === 'error') errs2.push(m.text()) })
await page2.goto('http://127.0.0.1:3000/dcw', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 3500))
console.log('/dcw (untouched) console errors:', errs2.length ? errs2.slice(0, 3) : 'none')

await browser.close()
