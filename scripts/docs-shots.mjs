/**
 * 文档站渲染取证(一次性):首页 zh/en + 本体指南页截图。
 * 用法: node scripts/docs-shots.mjs <baseUrl> <outDir>
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:4173/AgentWorkShop'
const OUT = process.argv[3] || resolve('docs/audit/evidence/2026-10-24-idd-rag-ontology/docs-shots')
mkdirSync(OUT, { recursive: true })

const { launch, openPage } = await import('./ui/lib.mjs')
process.env.AW_BASE = BASE
const browser = await launch({ width: 1500, height: 1000 })
try {
  const page = await openPage(browser, { width: 1500, height: 1000, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))
  const pages = [
    ['/', 'docs-home-zh'],
    ['/en/', 'docs-home-en'],
    ['/guide/ontology.html', 'docs-ontology-zh'],
    ['/en/guide/ontology.html', 'docs-ontology-en'],
  ]
  for (const [path, name] of pages) {
    await page.goto(BASE + path, { waitUntil: 'networkidle0', timeout: 60000 })
    await new Promise(r => setTimeout(r, 1200))
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true })
    const len = await page.evaluate(() => document.body.innerText.length)
    console.log(`${name}: len=${len} errors=${errors.length}`)
  }
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 3).join('; '))
}
finally {
  await browser.close().catch(() => {})
}
