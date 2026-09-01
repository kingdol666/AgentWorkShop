/** 告警管线端到端:收紧预警带 → warn 边沿 → 实时告警面板行即时出现 → 还原。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const H = { authorization: 'Bearer ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', 'content-type': 'application/json' }
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }
const jget = u => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jpatch = (u, b) => fetch(ROOT + u, { method: 'PATCH', headers: H, body: JSON.stringify(b) }).then(r => r.json())

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)

// 选一个在采节点,把预警上界压到当前值下方 → 触发 warn
const daqAll = (await jget('/api/workshop/daq')).data
const node = daqAll.nodes.find(n => n.value != null && n.enabled && n.state === 'ok')
if (!node) { fail('无在采健康节点可测'); process.exit(1) }
const tightHigh = +(node.value - Math.max(0.5, Math.abs(node.value) * 0.01)).toFixed(2)
console.log(`[告警] ${node.name} 当前 ${node.value},收紧 warnHigh → ${tightHigh}`)
await jpatch(`/api/workshop/daq/${node.id}`, { warnHigh: tightHigh })

// 等 warn 帧到达(采样 1s + 边沿检测即时)
await sleep(6000)
const warnRows = await page.evaluate(() =>
  [...document.querySelectorAll('.alarm-list .al-row')].map(r => r.textContent).join('◇'))
const hit = warnRows.includes(node.name)
console.log('[告警] 面板含目标节点告警:', hit ? `PASS(行内容: ${warnRows.slice(0, 120)})` : `FAIL(面板: ${warnRows.slice(0, 120) || '空'})`)
if (!hit) fail('warn 边沿未即时渲染到告警面板')

// 还原预警带
const restore = await jpatch(`/api/workshop/daq/${node.id}`, { warnHigh: node.warnHigh })
console.log('[告警] 预警带已还原:', restore?.code === 0 || restore?.data ? 'OK' : JSON.stringify(restore).slice(0, 100))
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-alarm-pipeline.png' })
await browser.close()
console.log(process.exitCode ? 'FAILED' : 'ALL PASS')
