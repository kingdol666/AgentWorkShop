/**
 * 闭环实验 UI 目视验证 —— 产线管理(/dcw)/数采(/daq)/数字孪生(/town)三页真实截图。
 *
 * 前置:主项目生产实例(BASE,默认 :3001)已登录可用;实验夹具已建。
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/experiment-castfilm-ui-shot.mjs [out-dir]
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const OUT = process.argv[2] ?? 'docs/experiments/results/castfilm-ui'
fs.mkdirSync(OUT, { recursive: true })

// 登录拿 token(全新数据态:首注册即 admin)
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
}).then(r => r.json()).catch(() => ({}))
const token = login?.data?.token
if (!token) {
  console.error('登录失败:', JSON.stringify(login).slice(0, 200))
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  // 本机 7890 系统代理会拦 localhost 动态模块 → 必须直连
  args: ['--no-sandbox', '--disable-gpu', '--proxy-server=direct://', '--proxy-bypass-list=*', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
const shot = async (url, name, waitMs = 9000) => {
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await new Promise(r => setTimeout(r, waitMs))
  await page.screenshot({ path: path.join(OUT, name) })
  console.log(`shot: ${name}`)
}

await shot('/', '01-dashboard.png', 10_000)
await shot('/dcw', '02-lines-dcw.png')
await shot('/daq', '03-daq.png')
await shot('/town', '04-town.png', 14_000)
await shot('/workshop/agents', '05-agents.png')

console.log('pageerrors:', errors.length ? errors.join(' | ') : 'none')
await browser.close()
