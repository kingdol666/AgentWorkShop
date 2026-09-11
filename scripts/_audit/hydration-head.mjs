/**
 * 水合差异定位(局部)—— 打印 SSR 与水合后 DOM 的同一区域原始片段。
 * 用法:node scripts/_audit/hydration-head.mjs [base] [path] [start] [len]
 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const PATH = process.argv[3] ?? '/dcw'
const START = Number(process.argv[4] ?? 0)
const LEN = Number(process.argv[5] ?? 700)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

async function main() {
  const ssr = await (await fetch(`${BASE}${PATH}`)).text()
  const browser = await puppeteer.launch({ executablePath: EXEC, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } })
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.goto(`${BASE}${PATH}`, { waitUntil: 'networkidle2' })
  const dom = await page.evaluate(() => document.querySelector('#__nuxt')?.outerHTML ?? '')
  await browser.close()

  const find = (html) => {
    const i = html.indexOf('aw-sidebar')
    return i >= 0 ? i : 0
  }
  for (const [label, html] of [['SSR', ssr], ['DOM', dom]]) {
    const i = find(html) + START
    console.log(`\n===== ${label} @${i} =====`)
    console.log(html.slice(i, i + LEN))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
