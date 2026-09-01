/**
 * 视觉验证:/daq 双面板(实时告警+实时事件)/ /logs 日志管理 / /town 孪生场景实时渲染。
 * 输出 PNG 到 docs/audit/screenshots/opslog/;场景实时性 = 两次采样 callout 值必变化。
 * 运行:AW_PAGE_TOKEN=<token> node scripts/_dbg-opslog-shots.mjs
 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--proxy-server=direct://', '--proxy-bypass-list=*', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

// ---- 1) /daq:双面板(实时告警 + 实时事件) ----
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 120000 })
await sleep(10000)
const panels = await page.evaluate(() => ({
  alarmPanel: !!document.querySelector('.alarm-panel'),
  eventPanel: !!document.querySelector('.event-panel'),
  evtRows: document.querySelectorAll('.evt-row').length,
  alarmRows: document.querySelectorAll('.alarm-row').length,
}))
console.log('/daq panels:', JSON.stringify(panels))
await page.screenshot({ path: 'docs/audit/screenshots/opslog/daq-panels.png' })

// ---- 2) /logs:日志管理页(筛选/表格/实时) ----
await page.goto('http://127.0.0.1:3000/logs', { waitUntil: 'domcontentloaded', timeout: 120000 })
await sleep(9000)
const logsState = await page.evaluate(() => ({
  rows: document.querySelectorAll('.log-table tbody tr').length,
  chips: document.querySelectorAll('.scope-chip').length,
  badges: document.querySelectorAll('.src-badge').length,
}))
console.log('/logs state:', JSON.stringify(logsState))
await page.screenshot({ path: 'docs/audit/screenshots/opslog/logs-page.png' })

// ---- 3) /town:孪生场景实时渲染(callout 值两次采样必变化) ----
await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 120000 })
await sleep(16000)
const sampleCallouts = () => page.evaluate(() => [...document.querySelectorAll('.callout .co-val')].map(e => e.textContent?.trim()).slice(0, 12))
try {
  await page.waitForFunction(() => document.querySelectorAll('.callout').length > 0, { timeout: 30000 })
}
catch {
  console.log('warn: 场景无 callout(可能镜头距离远/无数采节点)')
}
const v1 = await sampleCallouts()
await sleep(6000)
const v2 = await sampleCallouts()
const changed = v1.filter((x, i) => v2[i] !== undefined && v1[i] !== v2[i]).length
console.log(`/town callouts: n=${v1.length} 值变化通道=${changed}`)
console.log('  t0:', JSON.stringify(v1.slice(0, 6)))
console.log('  t1:', JSON.stringify(v2.slice(0, 6)))
await page.screenshot({ path: 'docs/audit/screenshots/opslog/town-live.png' })

console.log('VISUAL PASS:', panels.alarmPanel && panels.eventPanel && logsState.rows > 0 && v1.length > 0 && changed > 0 ? 'ALL GREEN' : 'CHECK ABOVE')
await browser.close()
