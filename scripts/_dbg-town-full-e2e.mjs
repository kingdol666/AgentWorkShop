/** 数字孪生完整 E2E:帧率切换/实时消费/趋势/绑定/数采/数控下发/事件渲染。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const H = { authorization: 'Bearer ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', 'content-type': 'application/json' }
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }
const jget = u => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 140)))
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

// ===== 1. 绑定事实(API 权威):device ↔ node =====
const daqAll = (await jget('/api/workshop/daq')).data
const dcwAll = (await jget('/api/workshop/dcw')).data
const boundDaq = daqAll.nodes.filter(n => n.deviceBindingId)
const boundDcw = dcwAll.nodes.filter(n => n.deviceBindingId)
console.log(`[绑定] 数采已绑设备 ${boundDaq.length} 路,智控已绑设备 ${boundDcw.length} 路`)
if (!boundDaq.length || !boundDcw.length) fail('缺少 device↔node 绑定')

// ===== 2. 数采:读数帧持续到达 =====
const produced0 = daqAll.meta.produced
await sleep(2500)
const produced1 = (await jget('/api/workshop/daq')).data.meta.produced
console.log(`[数采] produced ${produced0} → ${produced1}`, produced1 > produced0 ? 'PASS(采样流活跃)' : 'FAIL(无新样本)')

// ===== 3. 数控下发:REST 写 + 回读 ACK(选 1号产线的设定节点,写完还原) =====
const target = boundDcw.find(n => n.lineId && dcwAll.lineStates?.find(s => s.lineId === n.lineId)?.active) ?? boundDcw[0]
if (!target) fail('无可下发的智控节点')
else {
  const orig = target.value
  const wv = +(orig + 2).toFixed(2)
  const w = await jpost(`/api/workshop/dcw/${target.id}/write`, { value: wv })
  const okWrite = w?.data?.outcome?.ok ?? w?.data?.outcome?.ack
  console.log(`[数控] write ${target.name} ${orig} → ${wv}:`, JSON.stringify(w.data?.outcome ?? w).slice(0, 120))
  await sleep(1200)
  const after = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === target.id)
  const hit = Math.abs((after?.value ?? NaN) - wv) < 0.01
  console.log(`[数控] 回读 ${after?.value}(期望 ${wv})`, hit ? 'PASS(参数真正下发)' : 'FAIL')
  // 还原
  await jpost(`/api/workshop/dcw/${target.id}/write`, { value: orig })
  if (!hit) fail('数控下发未生效')
}

// ===== 4. 孪生页面:帧率切换 + 实时消费 + 趋势 + 事件 =====
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(16000)

// 4a. 帧率切换:60 → 120 → ∞(预算 16.7/8.3/0)
for (const [label, want] of [['60', 16.7], ['120', 8.3], ['∞', 0]]) {
  await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.fps-seg button')].find(b => b.textContent.trim() === l)
    btn?.click()
  }, label)
  await sleep(300)
  const s = await page.evaluate(() => ({ budget: globalThis.__townScene3d?.frameBudgetMs, alive: !globalThis.__townScene3d?.disposed }))
  const ok = s && Math.abs(s.budget - want) < 0.15 && s.alive
  console.log(`[帧率] 选 ${label} → budget ${s?.budget}`, ok ? 'PASS' : `FAIL(期望 ${want})`)
  if (!ok) fail('帧率切换未生效')
}
// 恢复 60
await page.evaluate(() => { [...document.querySelectorAll('.fps-seg button')].find(b => b.textContent.trim() === '60')?.click() })

// 4b. 实时消费:标注数值 4s 内变化(WS 帧 → rtc → 上屏)
const calloutChanges = await page.evaluate(() => new Promise((resolve) => {
  const texts = []
  const iv = setInterval(() => {
    texts.push([...document.querySelectorAll('.callout .co-val')].map(e => e.textContent).join('|'))
  }, 100)
  setTimeout(() => { clearInterval(iv); resolve(texts.filter((v, i) => i && v !== texts[i - 1]).length) }, 4000)
}))
console.log('[实时] 标注 4s 变化次数:', calloutChanges, calloutChanges >= 3 ? 'PASS' : 'FAIL')
if (calloutChanges < 3) fail('标注数据未实时刷新')

// 4c. 趋势曲线实时:画布内容 4s 内变化(200ms 重绘 + rtc 直方)
const trendChanges = await page.evaluate(() => new Promise((resolve) => {
  const cv = document.querySelector('.trend-cv')
  if (!cv) { resolve(-1); return }
  const frames = []
  const iv = setInterval(() => {
    try { frames.push(cv.toDataURL()) } catch { frames.push('err') }
  }, 150)
  setTimeout(() => { clearInterval(iv); resolve(frames.filter((v, i) => i && v !== frames[i - 1]).length) }, 4000)
}))
console.log('[实时] 趋势画布 4s 内容变化:', trendChanges, trendChanges >= 2 ? 'PASS' : 'FAIL(数据/曲线未动)')
if (trendChanges < 2) fail('趋势曲线未实时重绘')

// 4d. 事件渲染:实时告警面板行 + 实时事件轨
const alarmRows = await page.evaluate(() => document.querySelectorAll('.alarm-list .al-row').length)
const eventRows = await page.evaluate(() => document.querySelectorAll('.event-list .event-row').length)
console.log('[事件] 告警行:', alarmRows, '| 事件行:', eventRows)
if (!alarmRows && !eventRows) fail('告警与事件均未渲染(若产线无任何异常可豁免)')

console.log('pageerror:', errors.length ? errors.slice(0, 4) : 'none')
if (errors.length) fail('页面存在运行时错误')
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-final-e2e.png' })
await browser.close()
console.log(process.exitCode ? 'E2E FAILED' : 'E2E ALL PASS')
