/** 一次性:UI 打磨验证轮 2 —— 客户端路由 page-fade 类捕获 */
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

await page.goto(`${BASE}/tokens`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 5000))

// 客户端导航:点击侧栏「运行时监控」
const seen = { leave: false, enter: false }
page.on('framenavigated', () => {})
const clickAndWatch = async () => {
  const items = await page.$$('.menu-item')
  // 第 8 个 = /monitor
  await items[7].click()
  for (let i = 0; i < 60; i++) {
    const r = await page.evaluate(() => ({
      leave: !!document.querySelector('.page-fade-leave-active'),
      enter: !!document.querySelector('.page-fade-enter-active'),
      path: location.pathname,
    }))
    if (r.leave) seen.leave = true
    if (r.enter) seen.enter = true
    if (r.path === '/monitor' && !r.enter && !r.leave && i > 5) break
    await new Promise(r2 => setTimeout(r2, 10))
  }
}
await clickAndWatch()
console.log('T2 page-fade leave seen:', seen.leave, '| enter seen:', seen.enter)
await new Promise(r => setTimeout(r, 2500))
console.log('T2 final path ok:', await page.evaluate(() => location.pathname))
await page.screenshot({ path: `${OUT}/t2-monitor-after-clientnav.png` })
await browser.close()
console.log('verify2 done')
