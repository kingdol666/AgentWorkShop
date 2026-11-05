#!/usr/bin/env node
/** 渲染论文核心架构图: HTML -> PNG(2x, ~300dpi @ \linewidth) + PDF(矢量文本)。 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const html = resolve(HERE, '2026-11-05-aw-paper-core-figure.html')
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 })
await page.goto(`file:///${html.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' })
await new Promise(r => setTimeout(r, 600))
await page.screenshot({ path: resolve(HERE, '2026-11-05-aw-paper-core-figure.png'), clip: { x: 0, y: 0, width: 1600, height: 1000 } })
await page.pdf({
  path: resolve(HERE, '2026-11-05-aw-paper-core-figure.pdf'),
  width: '1600px', height: '1000px', printBackground: true, pageRanges: '1',
  margin: { top: 0, bottom: 0, left: 0, right: 0 },
})
await browser.close()
console.log('rendered: 2026-11-05-aw-paper-core-figure.png / .pdf')
