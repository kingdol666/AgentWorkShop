/** 一次性:UI 打磨验证轮 3 —— page-fade 用 MutationObserver 捕获(只读观测) */
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

await page.goto(`${BASE}/tokens`, { waitUntil: 'networkidle0', timeout: 90000 })
await new Promise(r => setTimeout(r, 4000))

// 只读 MutationObserver:记录 page-fade 类的出现
await page.evaluate(() => {
  window.__fadeSeen = { leave: 0, enter: 0 }
  const mo = new MutationObserver(() => {
    if (document.querySelector('.page-fade-leave-active')) window.__fadeSeen.leave++
    if (document.querySelector('.page-fade-enter-active')) window.__fadeSeen.enter++
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
})

// 点击侧栏「运行时监控」(重试至路径变化)
const items = await page.$$('.menu-item')
await items[7].click()
for (let i = 0; i < 20; i++) {
  const path = await page.evaluate(() => location.pathname)
  if (path === '/monitor') break
  const list = await page.$$('.menu-item')
  await list[7].click()
  await new Promise(r => setTimeout(r, 700))
}
await new Promise(r => setTimeout(r, 1200))
const seen = await page.evaluate(() => window.__fadeSeen)
console.log('T2 fade leave count:', seen.leave, '| enter count:', seen.enter)
console.log('T2 final path:', await page.evaluate(() => location.pathname))
await page.screenshot({ path: `${OUT}/t2-monitor-after-clientnav.png` })
await browser.close()
console.log('verify3 done')
