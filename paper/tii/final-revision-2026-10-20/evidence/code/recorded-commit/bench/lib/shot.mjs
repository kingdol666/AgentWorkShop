/**
 * bench/lib/shot.mjs —— 报告截图工具：report.html → PNG（视觉验收/存档用）。
 * 复用仓库惯例：puppeteer-core + 本机 Edge/Chrome（无需下载 Chromium）。
 * 用法：node bench/lib/shot.mjs <report.html路径> [输出.png]
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const input = process.argv[2] ?? join(REPO, 'bench', 'results', 'latest', 'report.html')
const out = process.argv[3] ?? input.replace(/\.html$/, '.png')
const url = 'file:///' + resolve(input).replace(/\\/g, '/')

const browser = await puppeteer.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox', '--force-dark-mode=false'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1.5 })
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.screenshot({ path: out, fullPage: true })
  console.log(`截图完成: ${out}`)
} finally {
  await browser.close()
}
