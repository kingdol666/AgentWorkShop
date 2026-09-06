// ============================================================
// 首启自注册(setup-flow)E2E 验证:_dbg-setup-e2e.mjs <baseURL>
// 断言链:setup-status=true → 登录门呈现"创建管理员账号"(仅注册页签) →
// 浏览器真实填表注册 → 进入 workspace → setup-status=false → 登录/me 均 admin。
// 用法:node scripts/_dbg-setup-e2e.mjs http://127.0.0.1:3002
// ============================================================
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3002'
const CREDS = { name: 'admin', email: 'admin@awshop.local', password: 'Awshop2026' }
const SHOT_DIR = '.e2e-shots'
mkdirSync(SHOT_DIR, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ---- 1. API:初始状态应 needsSetup=true ----
const s0 = await api('/api/users/setup-status')
check('setup-status 初始 needsSetup=true', s0.status === 200 && s0.body?.data?.needsSetup === true, JSON.stringify(s0.body?.data))

// ---- 2. 浏览器:登录门 setup 模式 + 真实注册 ----
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
  const gateText = await page.evaluate(() => document.body.innerText)
  check('登录门呈现 setup 模式(创建管理员账号)', gateText.includes('创建管理员账号'))
  check('setup 模式隐藏登录页签', !gateText.includes('账号登录') || gateText.indexOf('注册管理员') < gateText.indexOf('账号登录'))
  check('setup 模式隐藏 Token 登录页签', !gateText.includes('Token 登录'))
  check('提示首个注册账号成为管理员', gateText.includes('首个注册的账号将成为管理员'))
  await page.screenshot({ path: `${SHOT_DIR}/setup-1-form.png` })

  // 填表:auth-card 内 第1个input=用户名, type=email=邮箱, type=password=密码
  await page.waitForSelector('.auth-card input')
  const nameInput = (await page.$$('.auth-card input'))[0]
  await nameInput.click({ clickCount: 3 })
  await nameInput.type(CREDS.name)
  const emailInput = await page.$('.auth-card input[type="email"]')
  await emailInput.click({ clickCount: 3 })
  await emailInput.type(CREDS.email)
  const pwInput = await page.$('.auth-card input[type="password"]')
  await pwInput.click({ clickCount: 3 })
  await pwInput.type(CREDS.password)
  await page.keyboard.press('Enter')

  // 注册成功 → store 置登录态 → 登录门消失,workspace 出现
  await page.waitForFunction(() => document.body.innerText.includes('Workshop'), { timeout: 30000 })
  await new Promise(r => setTimeout(r, 1500))
  const afterText = await page.evaluate(() => document.body.innerText)
  check('注册后放行进入项目(workspace 呈现)', afterText.includes('Workshop') && !afterText.includes('创建管理员账号'))
  await page.screenshot({ path: `${SHOT_DIR}/setup-2-entered.png` })
}
finally {
  await browser.close()
}

// ---- 3. API:注册后状态收敛 + 新管理员可登录 ----
const s1 = await api('/api/users/setup-status')
check('注册后 setup-status=false', s1.status === 200 && s1.body?.data?.needsSetup === false, JSON.stringify(s1.body?.data))

const login = await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: CREDS.email, password: CREDS.password }) })
check('新管理员密码登录成功', login.status === 200 && login.body?.data?.user?.role === 'admin', JSON.stringify(login.body?.data?.user))
const me = await api('/api/users/me', { headers: { authorization: `Bearer ${login.body?.data?.token}` } })
check('/api/users/me 返回 admin 身份', me.status === 200 && me.body?.data?.role === 'admin')

// ---- 4. 注册页签收敛后再注册第二账号应降为普通 user ----
const reg2 = await api('/api/users/register', { method: 'POST', body: JSON.stringify({ name: 'plainuser', email: 'plain@awshop.local', password: 'Plain2026' }) })
check('后续注册为普通 user 角色', reg2.status === 200 && reg2.body?.data?.user?.role === 'user', JSON.stringify(reg2.body?.data?.user))

const failed = results.filter(r => !r.ok)
console.log(`\n===== setup-flow E2E: ${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
