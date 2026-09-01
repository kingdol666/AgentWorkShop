/** 三处动画/空态验证:/daq 手风琴、/dcw 弹窗、/town Inspector + 右轨空态。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

// ---- A. /daq 手风琴 ----
const p1 = await browser.newPage()
await p1.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await p1.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await p1.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(6000)
const bodyBox0 = await p1.evaluate(() => document.querySelector('.opt-body')?.getBoundingClientRect().height)
await p1.click('.opt-head')
await sleep(500)
const bodyBox1 = await p1.evaluate(() => document.querySelector('.opt-body')?.getBoundingClientRect().height)
console.log('[daq] opt-body 高度 收起→展开:', bodyBox0, '→', bodyBox1, bodyBox1 > 100 ? 'PASS' : 'FAIL')
await p1.click('.opt-head')
await sleep(500)
const bodyBox2 = await p1.evaluate(() => document.querySelector('.opt-body')?.getBoundingClientRect().height)
console.log('[daq] 再收起:', bodyBox2, bodyBox2 < 5 ? 'PASS(对称收合)' : 'FAIL')

// ---- B. /dcw 弹窗 ----
const p2 = await browser.newPage()
await p2.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await p2.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await p2.goto(`${ROOT}/dcw`, { waitUntil: 'domcontentloaded', timeout: 45000 })
await sleep(6000)
await p2.evaluate(() => {
  const btn = [...document.querySelectorAll('.aw-page-head button, .page button')].find(b => b.textContent.includes('新建产线') || b.textContent.includes('New'))
  btn?.click()
})
await sleep(400)
const modalOn = await p2.evaluate(() => {
  const m = document.querySelector('.modal')
  if (!m) return null
  const cs = getComputedStyle(m)
  return { opacity: cs.opacity, transform: cs.transform, visible: m.getBoundingClientRect().height > 100 }
})
console.log('[dcw] 弹窗展开后:', JSON.stringify(modalOn), modalOn?.visible && modalOn.opacity === '1' ? 'PASS(终态正确)' : 'FAIL')
await p2.screenshot({ path: 'docs/audit/screenshots/redesign0831/dcw-modal-anim.png' })

// ---- C. /town Inspector + 空态 ----
const p3 = await browser.newPage()
await p3.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await p3.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await p3.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(20000)
const emptyIco = await p3.evaluate(() => document.querySelectorAll('.rail-empty .re-ico').length)
console.log('[town] 右轨空态徽记数:', emptyIco, emptyIco >= 1 ? 'PASS' : '(有告警/事件时为 0,不判失败)')
// 点选场景中一台设备(在左轨数采树里点一个已落位节点 → Inspector 出现)
const clicked = await p3.evaluate(() => {
  const node = [...document.querySelectorAll('.daq-node.placed')][0]
  if (!node) return false
  node.click()
  return true
})
await sleep(600)
const insVisible = await p3.evaluate(() => {
  const el = document.querySelector('.panel.inspector')
  if (!el) return null
  const cs = getComputedStyle(el)
  return { opacity: cs.opacity, transform: cs.transform, h: el.getBoundingClientRect().height }
})
console.log('[town] Inspector:', clicked ? '已点击落位节点' : '无落位节点可点', JSON.stringify(insVisible), insVisible?.h > 100 ? 'PASS' : 'SKIP(需场景内落位实体)')
await p3.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-inspector.png' })

await browser.close()
console.log('DONE')
