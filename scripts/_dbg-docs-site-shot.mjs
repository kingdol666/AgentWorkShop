/**
 * 文档站截图走查 — vitepress preview(127.0.0.1:4477)+ Edge + puppeteer-core。
 * 用法:node scripts/_dbg-docs-site-shot.mjs
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:4477/AgentWorkShop'
const OUT = 'gui-test-screenshots/docs-site-v4'

const PAGES = [
  { name: "guide-getting-started", path: '/', width: 1440 },
  { name: 'guide-getting-started', path: '/guide/getting-started', width: 1440 },
  { name: 'license', path: '/guide/license', width: 1440 },
]

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' })
  for (const p of PAGES) {
    const page = await browser.newPage()
    await page.setViewport({ width: p.width, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle0', timeout: 30000 })
    await new Promise(r => setTimeout(r, 600))
    await page.screenshot({ path: `${OUT}/${p.name}.png`, fullPage: true })
    console.log('shot', p.name)
    await page.close()
  }
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
