/** Export authored local HTML to print-vector PDF and 300 dpi PNG. No external network. */
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
const manifest = JSON.parse(await readFile(join(root, 'figure-manifest.json'), 'utf8'))
const browser = await pw.chromium.launch({ headless: true })
const report = []
try {
  for (const f of manifest.figures) {
    const page = await browser.newPage({ viewport: { width: Math.ceil(f.width_mm / 25.4 * 96), height: Math.ceil(f.height_mm / 25.4 * 96) }, deviceScaleFactor: 300 / 96 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', route => route.request().url().startsWith('file:') || route.request().url().startsWith('data:') ? route.continue() : route.abort())
    await page.goto(pathToFileURL(join(root, f.name + '.html')).href)
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map(x => x.decode()))
    })
    await page.emulateMedia({ media: 'print' })
    const qa = await page.evaluate(() => {
      const svg = document.querySelector('svg'), b = svg.viewBox.baseVal
      const text = [...svg.querySelectorAll('text')].map((el) => {
        const r = el.getBBox()
        return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height }
      })
      const outside = text.filter(r => r.x < -0.2 || r.y < -0.2 || r.x + r.w > b.width + 0.2 || r.y + r.h > b.height + 0.2)
      const overlaps = []
      for (let i = 0; i < text.length; i++) for (let j = i + 1; j < text.length; j++) {
        const a = text[i], z = text[j]
        if (Math.min(a.x + a.w, z.x + z.w) - Math.max(a.x, z.x) > 1 && Math.min(a.y + a.h, z.y + z.h) - Math.max(a.y, z.y) > 1) overlaps.push([a.text, z.text])
      }
      return { outside, text_overlaps: overlaps, text_count: text.length, fonts: [...document.fonts].map(f => ({ family: f.family, status: f.status })) }
    })
    await page.pdf({ path: join(root, f.name + '.pdf'), preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, margin: { top: 0, right: 0, bottom: 0, left: 0 }, tagged: true })
    await page.locator('svg').screenshot({ path: join(root, f.name + '.png'), animations: 'disabled' })
    report.push({ name: f.name, errors, ...qa })
    console.log(f.name, JSON.stringify(qa))
    await page.close()
  }
  const gallery = []
  for (const width of [390, 1100]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.goto(pathToFileURL(join(root, 'index.html')).href)
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map(x => x.decode()))
    })
    const state = await page.evaluate(() => ({ sections: document.querySelectorAll('section').length, images: [...document.images].every(x => x.complete && x.naturalWidth > 0), horizontalOverflow: document.documentElement.scrollWidth > innerWidth }))
    if (state.sections !== 6 || !state.images || state.horizontalOverflow) throw new Error('Gallery QA failed: ' + JSON.stringify(state))
    gallery.push({ width, ...state })
    if (width === 1100) await page.screenshot({ path: join(root, 'gallery-preview.png'), fullPage: true })
    await page.close()
  }
  await writeFile(join(root, 'gallery-qa.json'), JSON.stringify(gallery, null, 2))
}
finally { await browser.close() }
await writeFile(join(root, 'export-qa.json'), JSON.stringify(report, null, 2))
if (report.some(r => r.errors.length || r.outside.length || r.text_overlaps.length)) process.exitCode = 1
