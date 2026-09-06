// 验收阶段5:前端可视化巡检(workshop 会话/产线/监控/数字孪生)
// 用法:node scripts/_dbg-acc-5-visual.mjs <base> <user> <pass> <channelId>
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const [USER, PASS, CHANNEL_ID] = [process.argv[3], process.argv[4], process.argv[5]]
mkdirSync('.e2e-shots', { recursive: true })
const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const login = await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: `${USER}@awshop.local`, password: PASS }) })
const TOKEN = login.body?.data?.token

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'],
})
const shots = []
const snap = async (page, name, wait = 2500) => {
  await new Promise(r => setTimeout(r, wait))
  const path = `.e2e-shots/acc-5-${name}.png`
  await page.screenshot({ path })
  shots.push(path)
  console.log('📷', path)
}
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
  await page.setCookie({ name: 'token', value: TOKEN, domain: new URL(BASE).hostname, path: '/' })

  // 1) workshop 总览(实时状态徽标)
  await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle2', timeout: 60000 })
  await snap(page, 'workshop-overview')

  // 2) channel 会话页(找 workspace 链接直达)
  const wsHref = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => a.getAttribute('href')).find(h => h?.startsWith('/workshop/w/')))
  if (wsHref) {
    await page.goto(`${BASE}${wsHref}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await snap(page, 'workshop-channel', 4000)
  }
  else {
    console.log('(未找到 workspace 链接,跳过会话页)')
  }

  // 3) 产线运营
  await page.goto(`${BASE}/dcw`, { waitUntil: 'networkidle2', timeout: 60000 })
  await snap(page, 'dcw-lines', 3000)

  // 4) 运行时监控
  await page.goto(`${BASE}/monitor`, { waitUntil: 'networkidle2', timeout: 60000 })
  await snap(page, 'monitor', 3000)

  // 5) 数字孪生(等 WS 快照与 3D/趋势渲染)
  await page.goto(`${BASE}/town`, { waitUntil: 'networkidle2', timeout: 90000 })
  await snap(page, 'town', 8000)
}
finally {
  await browser.close()
}
console.log('DONE', shots.length, 'screenshots')
