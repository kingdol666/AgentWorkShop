#!/usr/bin/env node
/** 渲染架构图: HTML -> PNG(2x, ~300dpi @ \textwidth) + PDF(矢量文本)。
 * 用法: node render_paper_figure.mjs [html文件名] [输出前缀] [宽] [高]
 * 缺省渲染 2026-11-05-aw-paper-core-figure (1600x1000)。 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [, , htmlArg, outArg, wArg, hArg] = process.argv
const htmlName = htmlArg ?? '2026-11-05-aw-paper-core-figure.html'
const out = outArg ?? htmlName.replace(/\.html$/, '')
const W = Number(wArg ?? 1600)
const H = Number(hArg ?? 1000)
const html = resolve(HERE, htmlName)
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 })
await page.goto(`file:///${html.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' })
await new Promise(r => setTimeout(r, 600))
await page.screenshot({ path: resolve(HERE, `${out}.png`), clip: { x: 0, y: 0, width: W, height: H } })
await page.pdf({
  path: resolve(HERE, `${out}.pdf`),
  width: `${W}px`, height: `${H}px`, printBackground: true, pageRanges: '1',
  margin: { top: 0, bottom: 0, left: 0, right: 0 },
})
await browser.close()
console.log(`rendered: ${out}.png / .pdf (${W}x${H})`)
