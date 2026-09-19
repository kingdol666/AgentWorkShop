/** Export the AgentTeam scenario figure to print-vector PDF and 300 dpi PNG.
 *
 *  The HTML carries the scientific animation under
 *  @media screen and (prefers-reduced-motion: no-preference); this exporter
 *  renders it in print media so the PDF and PNG are the complete still frame.
 *  No external network access.
 */
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let pw
try {
  pw = require('playwright')
}
catch {
  const p = process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/87287/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
  pw = require(p)
}

const NAME = process.argv[2] || 'fig11-agentteam-loop'
const { width_mm: W, height_mm: H } = JSON.parse(
  await readFile(join(root, `${NAME}.manifest.json`), 'utf8'))

const browser = await pw.chromium.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: Math.ceil((W / 25.4) * 96), height: Math.ceil((H / 25.4) * 96) },
  deviceScaleFactor: 300 / 96,
})
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.route('**/*', route =>
  route.request().url().startsWith('file:') || route.request().url().startsWith('data:')
    ? route.continue()
    : route.abort())
await page.goto(pathToFileURL(join(root, `${NAME}.html`)).href)
await page.evaluate(async () => {
  await document.fonts.ready
  await Promise.all([...document.images].map(x => x.decode()))
})
await page.emulateMedia({ media: 'print' })

const qa = await page.evaluate(() => {
  const svg = document.querySelector('svg')
  const b = svg.viewBox.baseVal
  const text = [...svg.querySelectorAll('text')].map((el) => {
    const r = el.getBBox()
    return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const outside = text.filter(
    r => r.x < -0.2 || r.y < -0.2 || r.x + r.w > b.width + 0.2 || r.y + r.h > b.height + 0.2)
  const overlaps = []
  for (let i = 0; i < text.length; i += 1) {
    for (let j = i + 1; j < text.length; j += 1) {
      const a = text[i]
      const z = text[j]
      if (Math.min(a.x + a.w, z.x + z.w) - Math.max(a.x, z.x) > 1
        && Math.min(a.y + a.h, z.y + z.h) - Math.max(a.y, z.y) > 1) {
        overlaps.push([a.text, z.text])
      }
    }
  }
  // Minimum rendered glyph size: viewBox units -> mm -> pt.
  const sizes = [...svg.querySelectorAll('text')].map(el =>
    parseFloat(getComputedStyle(el).fontSize))
  const minPx = Math.min(...sizes)
  const scale = 181.0 / b.width
  return {
    text_count: text.length,
    outside,
    text_overlaps: overlaps,
    min_font_pt: +(((minPx * scale) / 25.4) * 72).toFixed(3),
  }
})

await page.pdf({
  path: join(root, `${NAME}.pdf`),
  preferCSSPageSize: true,
  printBackground: true,
  displayHeaderFooter: false,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  tagged: true,
})
// Screenshot in print media: animations do not apply, so this is the still frame.
await page.locator('svg').screenshot({ path: join(root, `${NAME}.png`) })
await browser.close()

const report = { name: NAME, width_mm: W, height_mm: H, errors, ...qa }
await writeFile(join(root, `${NAME}-qa.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (errors.length || qa.outside.length || qa.text_overlaps.length || qa.min_font_pt < 5) {
  process.exitCode = 1
}
