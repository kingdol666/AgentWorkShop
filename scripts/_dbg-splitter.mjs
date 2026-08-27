/**
 * 分割线修复验证(一次性调试脚本):
 *  - lanes 视图:统计 .lane 与 .pane-splitter 数量(修复后应相等:每列右侧都有分隔条);
 *  - 模拟拖动最后一根分隔条向右 140px → 最右泳道宽度应增加;
 *  - split 视图(MultiChannelView):同结构校验 + 尾列拖宽验证;
 *  - 截图 + pageerror 收集。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const WS = process.env.AW_WS ?? 'cc05b5c1-d465-42fa-98c0-af8d61c3a413'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))

const readState = laneSel => page.evaluate((sel) => {
  const cols = [...document.querySelectorAll(sel)]
  const root = cols[cols.length - 1]?.closest('.lanes, .split')
  const sps = [...(root ?? document).querySelectorAll('.pane-splitter')]
  const last = cols[cols.length - 1]
  return {
    colCount: cols.length,
    splitterCount: sps.length,
    lastW: last ? Math.round(last.getBoundingClientRect().width) : -1,
  }
}, laneSel)

const dragLastSplitter = async (dx, colSel) => {
  const box = await page.evaluate((sel) => {
    const cols = [...document.querySelectorAll(sel)]
    // 先把容器滚到最右,确保尾部分隔条进入可视区(否则鼠标事件会落在右侧栏上)
    const root = cols[cols.length - 1]?.closest('.lanes, .split')
    if (root) root.scrollLeft = root.scrollWidth
    const sps = [...(root ?? document).querySelectorAll('.pane-splitter')]
    const last = sps[sps.length - 1]
    if (!last) return null
    const r = last.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 260) }
  }, colSel)
  if (!box) return false
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.round(dx / 2), box.y, { steps: 6 })
  await page.mouse.move(box.x + dx, box.y, { steps: 8 })
  await page.mouse.up()
  await new Promise(r => setTimeout(r, 300))
  return true
}

// ---- lanes 视图 ----
await page.goto(`${BASE}/workshop/w/${WS}?view=lanes`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 20; i++) {
  if (await page.evaluate(() => document.querySelectorAll('.lane').length > 0)) break
  await new Promise(r => setTimeout(r, 800))
}
await new Promise(r => setTimeout(r, 1200))
const lanesBefore = await readState('.lane')
await dragLastSplitter(140, '.lane')
const lanesAfter = await readState('.lane')
console.log('lanes before:', JSON.stringify(lanesBefore))
console.log('lanes after :', JSON.stringify(lanesAfter))
await page.screenshot({ path: 'docs/audit/screenshots/splitter-lanes.png' })

// ---- split(multi-channel)视图 ----
await page.goto(`${BASE}/workshop/w/${WS}?view=split`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 20; i++) {
  if (await page.evaluate(() => document.querySelectorAll('.split .col').length > 0)) break
  await new Promise(r => setTimeout(r, 800))
}
await new Promise(r => setTimeout(r, 1200))
const splitBefore = await readState('.split .col')
await dragLastSplitter(120, '.split .col')
const splitAfter = await readState('.split .col')
console.log('split before:', JSON.stringify(splitBefore))
console.log('split after :', JSON.stringify(splitAfter))
await page.screenshot({ path: 'docs/audit/screenshots/splitter-split.png' })

console.log('errors:', errors.slice(0, 6))
await browser.close()
