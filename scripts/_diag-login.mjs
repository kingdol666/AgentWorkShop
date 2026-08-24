/* eslint-disable -- 登录诊断(临时) */
import puppeteer from 'puppeteer-core'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const email = `diag-${Date.now().toString(36)}@test.local`
const reg = await (await fetch(`${BASE}/api/users/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'diag', email, password: 'Passw0rd!123' }),
})).json()
console.log('register ok:', reg.code === 0)

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
const logs = []
page.on('pageerror', e => logs.push('[pageerror] ' + e.message.slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') logs.push('[console.error] ' + m.text().slice(0, 200)) })
page.on('response', r => { if (r.url().includes('/api/')) logs.push(`[api] ${r.status()} ${r.url().split('/api/')[1]}`) })
await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle0', timeout: 90000 })
for (let i = 0; i < 30; i++) { if (await page.$('input[type=email]')) break; await sleep(500) }
const set = (sel, v) => page.$eval(sel, (el, val) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, v)
await set('input[type=email]', email)
await set('input[type=password]', 'Passw0rd!123')
await sleep(300)
const emailVal = await page.$eval('input[type=email]', el => el.value)
const pwVal = await page.$eval('input[type=password]', el => el.value)
console.log('filled email:', emailVal, 'pw:', pwVal)
const btns = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => ({ t: (b.textContent || '').trim().slice(0, 10), cls: b.className.slice(0, 40) })))
console.log('buttons:', JSON.stringify(btns))
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('登录') && x.className.includes('ant-btn-primary'))
  if (b) b.click()
})
await sleep(4000)
console.log('cookie after click:', await page.evaluate(() => document.cookie.slice(0, 100)))
console.log('loggedIn state:', await page.evaluate(() => document.body.textContent.includes('token 已保存') || document.body.textContent.includes('已登录')))
console.log('traffic+err:\n' + logs.slice(-12).join('\n'))
await page.screenshot({ path: 'gui-test-screenshots/_diag-login.png' })
await browser.close()
