import puppeteer from 'puppeteer-core'
const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(20000)
// 逐个展开数采模板分组,直到出现已落位节点
const expanded = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('.daq-card.tpl')]
  for (const h of heads) {
    h.click()
    if (document.querySelector('.daq-node.placed')) return true
  }
  return !!document.querySelector('.daq-node.placed')
})
await sleep(400)
const clicked = await page.evaluate(() => {
  const node = [...document.querySelectorAll('.daq-node.placed')][0]
  if (!node) return false
  node.click()
  return true
})
await sleep(600)
const ins = await page.evaluate(() => {
  const el = document.querySelector('.panel.inspector')
  if (!el) return null
  return { opacity: getComputedStyle(el).opacity, h: Math.round(el.getBoundingClientRect().height) }
})
console.log('展开分组:', expanded, '| 点击落位节点:', clicked, '| Inspector:', JSON.stringify(ins), ins && ins.h > 80 ? 'PASS' : 'FAIL/SKIP')
const el = await page.$('.town-root') ?? await page.$('body')
await el.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-inspector2.png' })
await browser.close()
console.log('DONE')
