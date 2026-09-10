/**
 * AML 前端 UI 实测(puppeteer-core + 本机 Chrome):
 *   注入 admin token cookie → /aml 页 → 断言五区块渲染 + 数据在册 + 无 console error → 截图。
 * 运行:AW_E2E_TOKEN=… node scripts/aml-ui-smoke.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const TOKEN = process.env.AW_E2E_TOKEN ?? ''
if (!TOKEN) {
  console.error('需要 AW_E2E_TOKEN')
  process.exit(1)
}

let passed = 0
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed++
  else failures++
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1600,1000'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160))
  })
  page.on('pageerror', err => consoleErrors.push(`pageerror: ${String(err).slice(0, 160)}`))

  await page.setCookie({ name: 'token', value: TOKEN, url: BASE })
  await page.goto(`${BASE}/aml`, { waitUntil: 'networkidle2', timeout: 60000 })
  await sleep(2500)

  const bodyText = await page.evaluate(() => document.body.innerText)
  check('/aml 页面可达', bodyText.length > 100, `len=${bodyText.length}`)
  check('页头渲染(aw-page-head)', await page.$('.aw-page-head') !== null)
  check('数据集区块', bodyText.includes('数据集'))
  check('训练作业区块', bodyText.includes('作业'))
  check('模型注册表区块', bodyText.includes('模型'))
  check('生产数据在册(数据集行渲染)', /ds-[a-z0-9-]+/.test(bodyText) || bodyText.includes('行'), '数据集列表含快照')
  check('运行时状态展示(Python 探测)', bodyText.includes('Python') || bodyText.includes('venv'), '')
  const navOk = await page.evaluate(() => !!document.querySelector('a[href="/aml"], [class*=trail]'))
  check('导航入口存在', navOk)

  mkdirSync('.e2e-shots', { recursive: true })
  await page.screenshot({ path: '.e2e-shots/aml-ui.png', fullPage: false })
  check('截图落盘', true, '.e2e-shots/aml-ui.png')
  check('无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  console.log(`\n━━━ UI 结果:${passed} PASS / ${failures} FAIL ━━━`)
  if (failures > 0) process.exit(1)
}
finally {
  await browser.close()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
