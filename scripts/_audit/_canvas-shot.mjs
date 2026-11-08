// 设计画布:聚焦某画板并截图(仅本地验证原型用)
// 用法: node scripts/_audit/_canvas-shot.mjs <file.dc.html> <outName>
import { readFileSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const FILE = process.argv[2]
const OUT = process.argv[3]
const ROOT = 'docs/design/2026-11-08-harness-ui/canvas'
const indexPath = `${ROOT}/project/canvas.json`
const index = JSON.parse(readFileSync(indexPath, 'utf8'))
index.launch = { view: 'focused', file: FILE }
writeFileSync(indexPath, JSON.stringify(index, null, 2))

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.goto('http://127.0.0.1:4720/design/JH80z2SRFz60FCD4APL7Zs/', { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 4500))
const fit = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Fit')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
if (fit) {
  await page.mouse.click(fit.x, fit.y)
  await new Promise(r => setTimeout(r, 1200))
}
await page.screenshot({ path: `docs/design/2026-11-08-harness-ui/canvas-shots/${OUT}.png` })
console.log('shot', OUT)
await browser.close()
process.exit(0)
