/**
 * Render the walkthrough figure HTML to (a) an exact-size PDF via headless Chrome
 * --print-to-pdf and (b) a high-resolution PNG for inspection/archival.
 *
 * Usage: node scripts/render-walkthrough-figure.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DIR = path.resolve('paper/tii/figures/walkthrough')
const SRC = path.join(DIR, 'fig-walkthrough.html')
if (!fs.existsSync(SRC)) throw new Error('missing ' + SRC)

// ── (a) exact-size PDF ────────────────────────────────────────────────────
const pdfUrl = 'file:///' + SRC.replace(/\\/g, '/')
const outPdf = path.resolve('paper/tii/figures/pdf/fig-walkthrough.pdf')
fs.mkdirSync(path.dirname(outPdf), { recursive: true })
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${outPdf}`, pdfUrl,
], { stdio: 'ignore' })
const info = execFileSync('pdfinfo', [outPdf], { encoding: 'utf8' })
console.log('PDF  :', outPdf)
console.log('     ', info.split('\n').filter(l => /Page size|Pages/.test(l)).join(' | ').trim())

// ── (b) high-resolution PNG (overall + per-panel) ─────────────────────────
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'] })
const page = await browser.newPage()
// 181 mm wide at 96 dpi/css == 684 css px; height is a minimum — fullPage grows to content
await page.setViewport({ width: 684, height: 200, deviceScaleFactor: 8 })
await page.goto(pdfUrl, { waitUntil: 'networkidle0' })
await page.evaluate(() => document.fonts?.ready)
await new Promise(r => setTimeout(r, 500))
await page.screenshot({ path: path.join(DIR, 'fig-walkthrough.png'), fullPage: true })
const png = fs.statSync(path.join(DIR, 'fig-walkthrough.png'))
console.log('PNG  :', path.join(DIR, 'fig-walkthrough.png'), `${(png.size / 1024).toFixed(0)} KB`)

// medium-res variant for quick review
await page.setViewport({ width: 684, height: 200, deviceScaleFactor: 2 })
await page.screenshot({ path: path.join(DIR, '_preview.png'), fullPage: true })
console.log('PREV :', path.join(DIR, '_preview.png'))

await browser.close()
