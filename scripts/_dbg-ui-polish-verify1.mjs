/** 一次性:UI 打磨验证轮 1 —— node-close 悬停显隐 / page-fade 类 / dcw Popconfirm */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const OUT = 'docs/audit/screenshots/ui-polish-0831'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

// ── T1: AppHeader 航点悬停 → 关闭钮淡入(预留槽位,零布局抖动) ──
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 9000))
const node = await page.$('.trail-node')
const box = await node.boundingBox()
const before = await page.evaluate(() => {
  const el = document.querySelector('.node-close')
  const cs = getComputedStyle(el)
  const chipW0 = document.querySelector('.trail-node').getBoundingClientRect().width
  return { opacity: cs.opacity, transform: cs.transform, chipW: chipW0 }
})
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await new Promise(r => setTimeout(r, 400))
const after = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.node-close'))
  const chipW1 = document.querySelector('.trail-node').getBoundingClientRect().width
  return { opacity: cs.opacity, transform: cs.transform, chipW: chipW1 }
})
console.log('T1 node-close before:', JSON.stringify(before))
console.log('T1 node-close after :', JSON.stringify(after), '| layoutShift =', Math.abs(after.chipW - before.chipW))
await page.screenshot({ path: `${OUT}/t1-header-hover.png`, clip: { x: 0, y: 0, width: 800, height: 56 } })

// ── T2: 路由切换 page-fade(仪表盘 → API Token) ──
const nav = page.goto(`${BASE}/tokens`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await nav
let sawEnterActive = false
for (let i = 0; i < 30; i++) {
  sawEnterActive = await page.evaluate(() => !!document.querySelector('.page-fade-enter-active, .page-fade-leave-active'))
  if (sawEnterActive) break
  await new Promise(r => setTimeout(r, 10))
}
await new Promise(r => setTimeout(r, 2000))
console.log('T2 page-fade class seen:', sawEnterActive)
await page.screenshot({ path: `${OUT}/t2-tokens-after-nav.png` })

// ── T3: dcw 产线卡 ✕ → Popconfirm(替代原生 confirm) ──
await page.goto(`${BASE}/dcw`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 8000))
const del = await page.$('.lc-del')
if (!del) {
  console.log('T3: no lc-del button found')
}
else {
  const dbox = await del.boundingBox()
  await page.mouse.move(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2)
  await new Promise(r => setTimeout(r, 200))
  await page.mouse.click(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2)
  await new Promise(r => setTimeout(r, 700))
  const pop = await page.evaluate(() => {
    const el = document.querySelector('.ant-popover')
    if (!el) return { open: false }
    const cs = getComputedStyle(el)
    return { open: cs.display !== 'none' && !el.classList.contains('ant-popover-hidden'), text: (el.innerText || '').slice(0, 60) }
  })
  console.log('T3 popconfirm:', JSON.stringify(pop))
  await page.screenshot({ path: `${OUT}/t3-dcw-popconfirm.png` })
  // 点取消关闭(不删除,无副作用)
  const cancelBtn = await page.$('.ant-popover .ant-btn:not(.ant-btn-dangerous)')
  if (cancelBtn) await cancelBtn.click()
  await new Promise(r => setTimeout(r, 500))
  const closed = await page.evaluate(() => {
    const el = document.querySelector('.ant-popover:not(.ant-popover-hidden)')
    return !el
  })
  console.log('T3 popconfirm dismissed (cancel):', closed)
  const lineCount = await page.evaluate(() => document.querySelectorAll('.line-card').length)
  console.log('T3 line cards intact:', lineCount)
}

await browser.close()
console.log('verify1 done')
