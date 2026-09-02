/**
 * 文档站截图走查 — vitepress preview(127.0.0.1:4477)+ Edge + puppeteer-core。
 * 用法:node scripts/_dbg-docs-site-shot.mjs [输出目录]
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:4477/AgentWorkShop'
const OUT = process.argv[2] ?? 'gui-test-screenshots/docs-site-v5'

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' })
  const shoot = async (name, path, { width = 1440, fullPage = true, height = 900 } = {}) => {
    const page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 30000 })
    await new Promise(r => setTimeout(r, 600))
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
    console.log('shot', name)
    await page.close()
  }
  await shoot('home-top', '/', { fullPage: false })
  await shoot('home', '/', {})
  await shoot('guide-getting-started', '/guide/getting-started', {})
  await shoot('guide-top', '/guide/getting-started', { fullPage: false })
  await shoot('license', '/guide/license', {})
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
