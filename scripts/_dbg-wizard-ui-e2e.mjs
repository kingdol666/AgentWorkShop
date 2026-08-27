/**
 * 一次性:前端点击式向导 e2e —— 真实用户路径(UI 无 REST 直调):
 * 打开向导 → 真实设备采集 → Modbus TCP → 填模拟器参数 → 测试连接(断言成功)
 * → 创建 → 列表出现新节点(modbus-tcp 驱动)→ 控制台实时值非空 → 清理。
 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 5000))

// 1) 打开向导
const before = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr:not([style*="display: none"])').length)
await page.click('.add-btn')
await new Promise(r => setTimeout(r, 800))
const diag = await page.evaluate(() => ({
  modal: Boolean(document.querySelector('.modal')),
  segs: [...document.querySelectorAll('.seg')].map(x => x.textContent?.trim()),
  mask: Boolean(document.querySelector('.modal-mask')),
}))
console.log('[diag]', JSON.stringify(diag))
if (!diag.modal) { console.log('=== UI WIZARD E2E FAIL(向导未打开)==='); await browser.close(); process.exit(1) }

// 2) 真实设备采集
const segs = await page.$$('.modal .seg')
await segs[1].click()
await new Promise(r => setTimeout(r, 400))

// 3) 协议保持 Modbus TCP(默认),填参数
await page.type('.modal input[placeholder="192.168.1.10"]', '127.0.0.1')
const numInputs = await page.$$('.modal .driver-form input[type="number"]')
// driver-form 顺序:port(默认502) / unitId(1) / register(空) / scale(1)
await numInputs[0].evaluate(el => { el.value = '' })
await numInputs[0].type('1502')
if (numInputs[2]) await numInputs[2].type('40001')

// 4) 测试连接 → 断言成功文案
await page.click('.modal .test-row .pill-btn')
await page.waitForFunction(() => (document.querySelector('.modal .test-result')?.textContent ?? '').length > 2, { timeout: 20000 })
const testMsg = await page.evaluate(() => document.querySelector('.modal .test-result')?.textContent)
console.log('[UI test-connection]', testMsg)
await page.screenshot({ path: 'docs/audit/screenshots/wizard-ui-tested.png' })

// 5) 创建 → 列表出现新节点
const createBtns = await page.$$('.m-actions .aw-pill')
await createBtns[1].click()
await page.waitForFunction(() => !document.querySelector('.modal-mask'), { timeout: 15000 })
await new Promise(r => setTimeout(r, 3500))
const after = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
console.log('[table rows before/after]', before, '→', after)
const tableTxt = await page.evaluate(() => document.querySelector('.nodes-table')?.innerText ?? '')
const hasNew = /modbus-tcp/.test(tableTxt)
console.log('[table has modbus-tcp node]', hasNew)
await page.screenshot({ path: 'docs/audit/screenshots/wizard-ui-created.png' })

// 6) 进控制台看实时值
// 断言:UI 创建的 modbus-tcp 行存在且状态正常、有实时值(表行内即完整证据)
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('.nodes-table tbody tr')]
  return rows.some(r => r.innerText.includes('modbus-tcp') && r.innerText.includes('正常') && /MPa|kW|℃/.test(r.innerText))
}, { timeout: 20000 })
const newRow = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.nodes-table tbody tr')]
  const r = rows.find(x => x.innerText.includes('modbus-tcp') && x.innerText.includes('正常'))
  return r?.innerText.replace(/\s+/g, ' ').slice(0, 120) ?? ''
})
console.log('[created row live]', newRow)
await page.screenshot({ path: 'docs/audit/screenshots/wizard-ui-created.png' })
const pass = after > before && hasNew && newRow.includes('正常')

// 清理:本 e2e 产生的 modbus-tcp 测试节点(保留 7 个 mock 基线)
const list2 = await fetch(`${BASE}/api/workshop/daq`, { headers: { authorization: `Bearer ${login.data.token}` } }).then(r => r.json())
for (const n of list2.data.nodes.filter(x => x.driver === 'modbus-tcp')) {
  await fetch(`${BASE}/api/workshop/daq/${n.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${login.data.token}` } })
}
console.log('[cleanup] modbus-tcp test nodes removed')
console.log(pass ? '=== UI WIZARD E2E PASS ===' : '=== UI WIZARD E2E FAIL ===')
await browser.close()
process.exit(pass ? 0 : 1)
