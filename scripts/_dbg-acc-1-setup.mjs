// 验收阶段1:setup 门注册 admin 账户(凭据经 argv 传入,不落源码)
// 用法:node scripts/_dbg-acc-1-setup.mjs <base> <adminUser> <adminPass>
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const [USER, PASS] = [process.argv[3], process.argv[4]]
const EMAIL = `${USER}@awshop.local`
mkdirSync('.e2e-shots', { recursive: true })

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const s0 = await api('/api/users/setup-status')
console.log(s0.body?.data?.needsSetup === true ? '✔ setup 状态:true(零用户)' : `✖ setup 状态异常: ${JSON.stringify(s0.body)}`)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
  await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.body.innerText.includes('创建管理员账号'), { timeout: 30000 })
  console.log('✔ setup 登录门呈现')

  await page.waitForSelector('.auth-card input')
  const nameInput = (await page.$$('.auth-card input'))[0]
  await nameInput.click({ clickCount: 3 })
  await nameInput.type(USER)
  const emailInput = await page.$('.auth-card input[type="email"]')
  await emailInput.click({ clickCount: 3 })
  await emailInput.type(EMAIL)
  const pwInput = await page.$('.auth-card input[type="password"]')
  await pwInput.click({ clickCount: 3 })
  await pwInput.type(PASS)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Workshop'), { timeout: 30000 })
  console.log('✔ 注册并自动进入项目')

  // 登录态确认:me 返回 admin
  const cookie = await page.cookies()
  const token = cookie.find(c => c.name === 'token')?.value
  const me = await api('/api/users/me', { headers: { authorization: `Bearer ${token}` } })
  console.log(me.body?.data?.role === 'admin' ? `✔ me=${me.body.data.name} role=admin` : `✖ me 异常: ${JSON.stringify(me.body)}`)
  await page.screenshot({ path: '.e2e-shots/acc-1-admin-entered.png' })

  const s1 = await api('/api/users/setup-status')
  console.log(s1.body?.data?.needsSetup === false ? '✔ setup 状态收敛:false' : '✖ setup 未收敛')
}
finally {
  await browser.close()
}
