/**
 * 实机截图取证：puppeteer-core + 本机 Edge，登录后抓取关键页面。
 * 用法：node scripts/_live-rsi-shots.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const OUT = join(REPO, 'docs/audit/evidence/2026-11-10-rsi-live-demo')
mkdirSync(OUT, { recursive: true })
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const browser = await puppeteer.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1.5 })

  // 登录页（全局 LoginModal，位于 / 下）
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2000))
  await page.screenshot({ path: join(OUT, '01-login.png'), fullPage: false })
  console.log('shot 01-login')

  // 令牌注入（http.ts 多通道：cookie token= → localStorage aw.token）后直接进各页
  await page.setCookie({ name: 'token', value: state.token, url: BASE })
  const shot = async (url, name, waitMs = 5000) => {
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
    await new Promise(r => setTimeout(r, waitMs))
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
    console.log(`shot ${name}`)
  }
  await shot('/', '03-dashboard')
  await shot('/dcw', '04-dcw-lines')
  await shot(`/dcw/${state.line.lineId}`, '05-dcw-line-detail', 6000)
  await shot('/workshop', '06-workshop-console')
  await shot('/projects', '09-projects-list')
  await shot(`/projects/${state.project.id}`, '08-project-board', 6000)
  writeFileSync(join(OUT, 'shot-state.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, line: state.line.lineId, project: state.project.id }, null, 2))
} finally {
  await browser.close()
}
console.log('[shots] done →', OUT)
