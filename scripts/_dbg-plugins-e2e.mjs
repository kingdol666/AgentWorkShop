// ============================================================
// 插件页(builtin 标识 + 错误人话渲染)E2E:_dbg-plugins-e2e.mjs <baseURL>
// 断言链:admin 登录 → /plugins 内置示例/用户级扩展徽标 → admin 切换成功并恢复 →
// plainuser 注册登录 → 切换被拒 → toast 为人话(含"管理员权限",不含 403/[POST])。
// 用法:node scripts/_dbg-plugins-e2e.mjs http://127.0.0.1:3021
// ============================================================
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const ADMIN = { email: 'admin@awshop.local', password: process.argv[3] ?? 'admin123' }
const PLAIN = { name: `plain-${Date.now().toString(36)}`, email: `plain-${Date.now().toString(36)}@awshop.local`, password: 'Plain2026' }
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

// ---- 0. plainuser 注册(注册后系统已有 admin → user 角色)----
const reg = await api('/api/users/register', { method: 'POST', body: JSON.stringify(PLAIN) })
check('后续注册为普通 user(前置)', reg.status === 200 && reg.body?.data?.user?.role === 'user', JSON.stringify(reg.body?.data?.user))

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })

  // ---- 1. admin 会话:内置徽标 + 切换成功 ----
  const adminLogin = await api('/api/users/login', { method: 'POST', body: JSON.stringify(ADMIN) })
  check('admin 登录(前置)', adminLogin.status === 200 && adminLogin.body?.data?.user?.role === 'admin')
  await page.setCookie({ name: 'token', value: adminLogin.body.data.token, domain: new URL(BASE).hostname, path: '/' })
  await page.goto(`${BASE}/plugins`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.body.innerText.includes('内置示例'), { timeout: 30000 })
  const adminText = await page.evaluate(() => document.body.innerText)
  check('内置示例徽标呈现(project 作用域)', adminText.includes('内置示例'))
  check('用户级扩展徽标呈现(user 作用域)', adminText.includes('用户级扩展'))
  check('旧「项目级」标签不再出现', !adminText.includes('项目级'))
  await page.screenshot({ path: `${SHOT_DIR}/plugins-1-admin-badges.png` })

  // admin 切换第一个启用的插件 → 成功 toast → 等热重载 → 切回恢复
  const firstSwitch = await page.$('.pg-card .ant-switch')
  if (firstSwitch) {
    await firstSwitch.click()
    await page.waitForFunction(() => document.body.innerText.includes('已停用') || document.body.innerText.includes('已启用'), { timeout: 20000 })
    await new Promise(r => setTimeout(r, 1800))
    const toastText = await page.evaluate(() => document.body.innerText)
    const toggledOk = toastText.includes('· 已停用') || toastText.includes('· 已启用')
    check('admin 切换插件成功', toggledOk)
    // 恢复原状态
    const sw2 = await page.$('.pg-card .ant-switch')
    if (sw2) { await sw2.click(); await new Promise(r => setTimeout(r, 1800)) }
  }
  else {
    check('admin 切换插件成功', false, '页面上没有插件卡片')
  }
  await page.evaluate(() => { document.cookie = 'token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' })

  // ---- 2. plainuser 会话:403 → 人话提示 ----
  const plainLogin = await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: PLAIN.email, password: PLAIN.password }) })
  check('plainuser 登录(前置)', plainLogin.status === 200 && plainLogin.body?.data?.user?.role === 'user')
  await page.setCookie({ name: 'token', value: plainLogin.body.data.token, domain: new URL(BASE).hostname, path: '/' })
  const denied = []
  page.on('response', (res) => {
    if (res.status() >= 400) denied.push(`${res.status()} ${res.url()}`)
  })
  await page.goto(`${BASE}/plugins`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.body.innerText.includes('内置示例'), { timeout: 30000 })
  const sw = await page.$('.pg-card .ant-switch')
  if (sw) {
    await sw.click()
    await page.waitForFunction(() => document.querySelector('.ant-message')?.textContent?.length > 0, { timeout: 20000 })
    const toast = await page.evaluate(() => document.querySelector('.ant-message')?.textContent ?? '')
    const human = /权限|管理员/.test(toast)
    const rawCode = /\b403\b|\[POST\]|ADMIN_REQUIRED|FORBIDDEN/.test(toast)
    check('403 提示为人话(权限相关文案)', human, toast.trim())
    check('提示不含错误码式文本', !rawCode)
    console.log('  [denied requests]', denied.join(' | ') || '(none)')
    await page.screenshot({ path: `${SHOT_DIR}/plugins-2-403-human.png` })
  }
  else {
    check('403 提示为人话(权限不足/需管理员)', false, '页面上没有插件卡片')
  }
}
finally {
  await browser.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n===== plugins E2E: ${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
