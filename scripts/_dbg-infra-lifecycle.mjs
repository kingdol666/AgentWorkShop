/** 一次性:降级横幅截图 → 启容器 → 手动重连 → 恢复截图 */
import puppeteer from 'puppeteer-core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const H = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

// 1) 降级横幅
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: 'docs/audit/screenshots/daq-infra-degraded.png' })
console.log('[shot] degraded banner')

// 2) 起容器 + 手动重连(页面按钮路径同此 REST)
await exec('docker', ['start', 'awshop-daq-mosquitto', 'awshop-daq-timescale'])
await new Promise(r => setTimeout(r, 6000))
const recon = await fetch(`${BASE}/api/workshop/daq/infra/reconnect`, { method: 'POST', headers: H }).then(r => r.json())
const infra = recon.data?.infra
console.log('[reconnect] degraded =', infra?.degraded, '| mqtt =', infra?.mqttOnline, '| tsdb =', infra?.tsdbOnline, '| startedBy =', infra?.startedBy)

// 3) 恢复后页面(横幅消失、采集恢复、TSDB/QUEUE 徽章为真实后端)
await page.reload({ waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: 'docs/audit/screenshots/daq-infra-recovered.png' })
console.log('[shot] recovered')
await browser.close()
