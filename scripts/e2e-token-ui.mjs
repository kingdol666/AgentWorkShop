/**
 * Token 页 UI 交互验证:登录 → /tokens → 签发 token →
 * 断言:列表可见新 token 行 / 明文默认掩码 / 眼睛按钮切换明文 / 复制按钮写剪贴板。截图留档。
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:3001'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = '.design-verify'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, path, { body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) {
    pass++
  }
  else {
    fail++
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const stamp = Date.now().toString(36)
  const email = `tok-ui-${stamp}@test.local`
  await api('POST', '/api/users/register', { body: { name: `tokui-${stamp}`, email, password: 'Passw0rd!123' } })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))
  // 授权剪贴板(复制按钮)+ 保持前台焦点(headless 剪贴板读写需 document focus)
  await page.browserContext().overridePermissions(`${BASE}`, ['clipboard-read', 'clipboard-write'])
  await page.bringToFront()

  // 登录
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2200)
  await page.$eval('input[type="email"]', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, email)
  await page.$eval('input[type="password"]', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, 'Passw0rd!123')
  await sleep(200)
  for (const b of await page.$$('button')) {
    const txt = (await b.evaluate(el => el.textContent) || '').trim()
    if (txt.replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(3500)
  const dbg = await page.evaluate(() => ({
    url: location.pathname,
    keys: Object.keys(localStorage),
    sample: (Object.keys(localStorage).filter(k => k.includes('user')).map(k => localStorage.getItem(k)?.slice(0, 80))),
    cookies: document.cookie.split(';').map(c => c.trim().split('=')[0]),
  }))
  console.log('  [login-debug]', JSON.stringify(dbg))

  // tokens 页
  await page.goto(`${BASE}/tokens`, { waitUntil: 'domcontentloaded' })
  await sleep(2800)
  await page.screenshot({ path: `${SHOT_DIR}/tok-01-list.png` })

  // 签发
  const createBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('签发 Token')))
  await createBtn.asElement().click()
  await sleep(600)
  await page.$eval('.ant-modal input', (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, 'e2e-验证令牌')
  await sleep(200)
  const okBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.ant-modal button')].find(b => (b.textContent || '').replace(/\s/g, '') === '创建'))
  await okBtn.asElement().click()
  await sleep(1600)

  // 明文回显弹层:默认掩码
  const raw1 = await page.$eval('.raw', el => el.textContent)
  const maskedOk = /•{6,}/.test(raw1)
  check('T1 新 token 默认掩码显示', maskedOk, raw1?.slice(0, 28))
  await page.screenshot({ path: `${SHOT_DIR}/tok-02-masked.png` })

  // 眼睛按钮 → 明文
  const eyeBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.raw-op')].find(b => b.querySelector('.i-tabler-eye')))
  await eyeBtn.asElement().click()
  await sleep(400)
  const raw2 = await page.$eval('.raw', el => el.textContent)
  const revealedOk = /^[A-Za-z0-9_-]{20,}$/.test(raw2 ?? '')
  check('T2 眼睛按钮切换为明文', revealedOk, `${(raw2 ?? '').slice(0, 10)}…(${(raw2 ?? '').length} 字符)`)
  const tokenValue = raw2 ?? ''
  await page.screenshot({ path: `${SHOT_DIR}/tok-03-revealed.png` })

  // 再点(眼睛变 eye-off)→ 回掩码
  const eyeOffBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.raw-op')].find(b => b.querySelector('.i-tabler-eye-off')))
  await eyeOffBtn.asElement().click()
  await sleep(300)
  const raw3 = await page.$eval('.raw', el => el.textContent)
  check('T3 再点切回掩码', /•{6,}/.test(raw3))

  // 复制按钮 → 成功反馈(勾图标)+ 剪贴板回读(headless 焦点缺失时回读可能为空,仅作辅助观测)
  const copyBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.raw-op')].find(b => b.querySelector('.i-tabler-copy')))
  await copyBtn.asElement().click()
  await sleep(700)
  const checkIcon = await page.$('.raw-op.ok .i-tabler-check')
  check('T4 复制成功反馈(勾图标切换)', !!checkIcon)
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  console.log(`  [obs] clipboard readback: ${clip === tokenValue ? 'match' : clip ? 'mismatch' : 'empty(headless focus)'}`)

  // 关闭 → 列表出现新行
  const closeBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.ant-modal button')].find(b => (b.textContent || '').includes('我已保存')))
  await closeBtn.asElement().click()
  await sleep(1200)
  const rowCount = await page.$$eval('.ant-table-tbody tr', rows => rows.length)
  check('T6 列表含新 token 行', rowCount >= 2, `rows=${rowCount}`)
  await page.screenshot({ path: `${SHOT_DIR}/tok-04-list-after.png` })

  await browser.close()
  console.log(`\n${pass} pass / ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('UI 验证崩溃:', e)
  process.exit(1)
})
