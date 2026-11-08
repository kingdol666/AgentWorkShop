// README 设计画板静态出图（画板只含内联样式，无 holes，可直接 file:// 渲染）
// 用法: node scripts/_audit/_readme-canvas-shot.mjs
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const ROOT = 'docs/design/2026-11-09-readme/canvas/project'
const OUT = 'docs/design/2026-11-09-readme/canvas-shots'
mkdirSync(OUT, { recursive: true })
const boards = [
  ['Main.dc.html', '01-readme-hero.png', 1280, 1040],
  ['Sections.dc.html', '02-readme-sections.png', 1280, 1480],
  ['DocsHome.dc.html', '03-vitepress-home.png', 1280, 1050],
]
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'],
})
const FONT_DIR = 'D:/codes/ABO/AW-sessions-ui/node_modules/@fontsource-variable'
const fontCss = `
@font-face { font-family: 'Geist'; font-weight: 100 900; font-style: normal; src: url('file:///${FONT_DIR}/geist/files/geist-latin-wght-normal.woff2') format('woff2-variations'); }
@font-face { font-family: 'Geist Mono'; font-weight: 100 900; font-style: normal; src: url('file:///${FONT_DIR}/geist-mono/files/geist-mono-latin-wght-normal.woff2') format('woff2-variations'); }
`
for (const [file, out, w, h] of boards) {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
  const errs = []
  page.on('pageerror', e => errs.push(String(e).slice(0, 120)))
  await page.goto('file:///' + path.resolve(ROOT, file).replace(/\\/g, '/'), { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: fontCss })
  // 画板里的 /_blob/<id> 由编辑器提供；静态 file:// 渲染时改指本地 assets 副本
  const assetDir = path.resolve(ROOT, 'assets').replace(/\\/g, '/')
  await page.evaluate((dir) => {
    for (const img of document.querySelectorAll('img')) {
      const m = (img.getAttribute('src') || '').match(/^\/_blob\/([A-Za-z0-9]+)$/)
      if (m) img.src = 'file:///' + dir + '/' + m[1] + '.png'
    }
  }, assetDir)
  await Promise.race([page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {})))), new Promise(r => setTimeout(r, 4000))])
  await Promise.race([page.evaluate(() => document.fonts.ready), new Promise(r => setTimeout(r, 4000))])
  await new Promise(r => setTimeout(r, 300))
  const box = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }))
  await page.screenshot({ path: `${OUT}/${out}` })
  console.log(out, `${box.sw}x${box.sh}`, errs.length ? 'ERR ' + errs.join(' | ') : 'ok')
  await page.close()
}
await browser.close()
