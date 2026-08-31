/** 一次性:dcw 产线卡片 编辑/级联删除 e2e + 双主题截图 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const TOKEN = 'ut-3b8495cf61b34bd4b3c0e02fc242fc66'
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const jpost = (p, b) => fetch(`${BASE}/api/workshop/dcw${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json())
const jget = p => fetch(`${BASE}/api/workshop/dcw${p}`, { headers: H }).then(r => r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- 准备:建 scratch 产线 + 1 个挂靠节点(验证 purge 级联) ----
const lineRes = await jpost('/lines', { name: '华书审-级联线', description: 'purge e2e' })
const line = lineRes.data.line
if (!line) throw new Error(`创建产线失败: ${JSON.stringify(lineRes)}`)
const nodeRes = await jpost('', { templateRef: 'dcw-temp-sp', name: '华书审-级联节点', lineId: line.id })
const node = nodeRes.data.node
if (!node) throw new Error(`创建节点失败: ${JSON.stringify(nodeRes)}`)
console.log('seeded line', line.id, 'node', node.id)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(`[pageerror] ${String(e).slice(0, 120)}`))
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

const findCard = name => page.evaluateHandle((n) => {
  const cards = [...document.querySelectorAll('.line-card')]
  return cards.find(c => c.querySelector('.lc-name')?.textContent?.trim() === n)
}, name)

// ---- 1) 编辑流:悬停出铅笔 → 改名 → 保存 → 卡片/REST 双验证 ----
await page.goto(`${BASE}/dcw`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await sleep(8000)
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/glass-dark-dcw2.png' })

const card = await findCard('华书审-级联线')
if (!card || !(await card.asElement())) throw new Error('未找到 scratch 卡片')
await card.asElement().hover()
await sleep(400)
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.line-card')]
  const c = cards.find(x => x.querySelector('.lc-name')?.textContent?.trim() === '华书审-级联线')
  c.querySelector('.lc-act:not(.danger)').click()
})
await sleep(600)
let modalOn = await page.evaluate(() => !!document.querySelector('.modal') && document.querySelector('.m-title')?.textContent?.includes('编辑产线'))
console.log('edit modal open:', modalOn ? 'OK' : 'FAIL')
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/edit-modal.png' })
await page.type('.modal .f .inp', '·已编辑')
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.modal .m-actions .pill-btn')]
  btns.find(b => b.textContent.includes('保存'))?.click()
})
await sleep(2500)
const editedUi = await page.evaluate(() => [...document.querySelectorAll('.lc-name')].some(x => x.textContent?.trim() === '华书审-级联线·已编辑'))
const linesAfterEdit = await jget('/lines')
const editedRest = linesAfterEdit.data.items?.some(l => l.name === '华书审-级联线·已编辑')
  ?? linesAfterEdit.data?.some?.(l => l.name === '华书审-级联线·已编辑')
  ?? JSON.stringify(linesAfterEdit).includes('华书审-级联线·已编辑')
console.log('edit applied:', editedUi && editedRest ? 'OK (UI+REST)' : `FAIL ui=${editedUi} rest=${editedRest}`)

// ---- 2) 删除流(purge 默认勾选):悬停出垃圾桶 → 弹窗 → 删除 → 卡片/REST 双验证 ----
const card2 = await findCard('华书审-级联线·已编辑')
await card2.asElement().hover()
await sleep(400)
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.line-card')]
  const c = cards.find(x => x.querySelector('.lc-name')?.textContent?.trim() === '华书审-级联线·已编辑')
  c.querySelector('.lc-act.danger').click()
})
await sleep(600)
const delInfo = await page.evaluate(() => ({
  open: !!document.querySelector('.modal'),
  title: document.querySelector('.m-title')?.textContent ?? '',
  summary: document.querySelector('.del-summary')?.textContent ?? '',
  purgeChecked: document.querySelector('.del-purge input')?.checked ?? null,
}))
const purgeSummaryOk = delInfo.summary.includes('节点 1') && delInfo.summary.includes('不可恢复')
console.log('delete modal:', delInfo.open && purgeSummaryOk && delInfo.purgeChecked === true ? 'OK' : `FAIL ${JSON.stringify(delInfo)}`)
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/delete-modal.png' })
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.modal .m-actions .pill-btn')]
  btns.find(b => b.textContent.trim() === '删除')?.click()
})
await sleep(3500)
const goneUi = await page.evaluate(() => ![...document.querySelectorAll('.lc-name')].some(x => x.textContent?.includes('华书审-级联线')))
const linesAfterDel = await jget('/lines')
const nodesAfter = await jget('')
const goneLine = !JSON.stringify(linesAfterDel).includes('华书审-级联线')
const goneNode = !JSON.stringify(nodesAfter).includes('华书审-级联节点')
console.log('purge cascade:', goneUi && goneLine && goneNode ? 'OK (卡片+产线+节点全清)' : `FAIL ui=${goneUi} line=${goneLine} node=${goneNode}`)

// ---- 3) 浅色模式截图 ----
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: null }))
})
await page.goto(`${BASE}/dcw`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await sleep(8000)
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/glass-light-dcw2.png' })
console.log('light shot done')

await browser.close()
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors')
