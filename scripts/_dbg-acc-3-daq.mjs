// 验收阶段3:数采中心可视化(列表状态 + 节点详情图表渲染)
// 用法:node scripts/_dbg-acc-3-daq.mjs <base> <user> <pass> <liveNodeId>
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const [USER, PASS, NODE_ID] = [process.argv[3], process.argv[4], process.argv[5]]
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
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
  await page.setCookie({ name: 'token', value: TOKEN, domain: new URL(BASE).hostname, path: '/' })

  // 1) 数采中心列表
  await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2500))
  const listText = await page.evaluate(() => document.body.innerText)
  const hasStats = /在线|online|节点/i.test(listText)
  console.log(hasStats ? '✔ 数采中心列表渲染' : '✖ 数采中心列表空')
  await page.screenshot({ path: '.e2e-shots/acc-3-daq-list.png' })

  // 2) 节点详情 + 图表
  await page.goto(`${BASE}/daq/${NODE_ID}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, 6000)) // 等实时数据+图表渲染
  const chart = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    svgs: document.querySelectorAll('svg').length,
    text: document.body.innerText.slice(0, 200).replace(/\n/g, ' '),
  }))
  console.log(`图表渲染: canvas=${chart.canvases} svg=${chart.svgs}`)
  console.log(chart.canvases + chart.svgs > 0 ? '✔ 图表已渲染' : '✖ 未见图表')
  await page.screenshot({ path: '.e2e-shots/acc-3-daq-detail.png' })
}
finally {
  await browser.close()
}
