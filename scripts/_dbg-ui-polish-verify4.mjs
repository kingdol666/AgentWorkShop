/** 一次性:UI 打磨验证轮 4 —— dcw Popconfirm 完整确认/取消链路 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

await page.goto(`${BASE}/dcw`, { waitUntil: 'networkidle0', timeout: 90000 })
await new Promise(r => setTimeout(r, 5000))
const count0 = await page.evaluate(() => document.querySelectorAll('.line-card').length)

const del = await page.$('.lc-del')
const dbox = await del.boundingBox()
await page.mouse.click(dbox.x + dbox.width / 2, dbox.y + dbox.height / 2)
await new Promise(r => setTimeout(r, 600))

// 点「取消」(popconfirm 按钮组内第一个按钮)
const cancelled = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.ant-popover:not([style*="display: none"]) .ant-popconfirm-buttons button, .ant-popover:not(.ant-popover-hidden) .ant-popconfirm-buttons button')]
  const cancel = btns.find(b => /取\s*消|Cancel/.test(b.innerText))
  if (!cancel) return false
  cancel.click()
  return true
})
await new Promise(r => setTimeout(r, 600))
const count1 = await page.evaluate(() => document.querySelectorAll('.line-card').length)
const popGone = await page.evaluate(() => !document.querySelector('.ant-popover:not(.ant-popover-hidden)'))
console.log('T3b cancel clicked:', cancelled, '| pop gone:', popGone, '| cards', count0, '→', count1, '| nothing deleted:', count0 === count1)

// 悬停 ✕ 时按压反馈 transform 存在性(只读检查 CSS 生效)
const hasTransition = await page.evaluate(() => {
  const el = document.querySelector('.lc-del')
  return getComputedStyle(el).transitionProperty.includes('transform')
})
console.log('T3b lc-del press transition wired:', hasTransition)
await browser.close()
console.log('verify4 done')
