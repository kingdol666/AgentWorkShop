/**
 * 应用 UI 截图走查 — dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 * 注册临时用户 → 会话 cookie → 截图指定页面。
 * 用法:node scripts/_dbg-app-shot.mjs [输出目录] [path1 path2 ...]
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = process.argv[2] ?? 'gui-test-screenshots/app-v1'
const PAGES = process.argv.slice(3).length ? process.argv.slice(3) : ['/']

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 })

  // 在页面上下文里注册临时用户(自动携带同源 cookie)
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  const reg = await page.evaluate(async () => {
    const id = Math.random().toString(36).slice(2, 8)
    const res = await fetch('/api/users/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `shot-${id}`, email: `shot-${id}@test.local`, password: 'Passw0rd!123' }),
    })
    return res.json()
  })
  const token = reg?.data?.token ?? reg?.data?.session?.token
  if (token) {
    await page.evaluate((t) => {
      document.cookie = `token=${t}; path=/`
    }, token)
  }
  console.log('registered:', !!token)

  for (const p of PAGES) {
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await new Promise(r => setTimeout(r, 2500))
    await page.screenshot({ path: `${OUT}/${p.replace(/\//g, '_') || 'root'}.png`, fullPage: true })
    console.log('shot', p)
  }
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
