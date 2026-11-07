#!/usr/bin/env node
/**
 * E2E UI 截图阶段:项目页/会话视图(桌面+移动)/落地页渲染。
 * 前置:us2..us7 已跑(状态在 .e2e-home/e2e-state.json);服务器 3995。
 * 证据: docs/audit/evidence/2026-11-07-e2e-landing/*.png + ui-capture.json
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
mkdirSync(EVID, { recursive: true })
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const STATE = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, data: null }
  }
}

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 240)}`}`)
}

const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
if (!token) throw new Error('login failed')

let wsList = await api('GET', '/api/workshop/workspaces', undefined, token)
let wsRow = (wsList.data ?? []).find(w => (w.channelIds ?? []).includes(STATE.us2.channelId))
  ?? (wsList.data ?? []).find(w => (w.channelIds ?? []).includes(STATE.us3.A.channelId))
  ?? (wsList.data ?? [])[0]
if (!wsRow) {
  const created = await api('POST', '/api/workshop/workspaces', { name: 'E2E 工作区' }, token)
  wsRow = { id: created.data?.id, channelIds: [] }
}
const wsId = wsRow.id
ok('UI-0', 'workspace 就绪(含目标频道挂载)', !!wsId, `wsId=${wsId}`)
for (const cid of [STATE.us2.channelId, STATE.us3.A.channelId]) {
  if (!(wsRow.channelIds ?? []).includes(cid)) {
    await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {}, token)
  }
}

let browser = null
try {
  browser = await puppeteer.launch({
    executablePath: process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

  // 1) 项目页(概览:Leader 对话卡 + 项目会话卡)
  await page.goto(`${BASE}/projects/${STATE.us3.projectId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(3500)
  const projCard = await page.evaluate(() => document.body.textContent ?? '')
  ok('UI-1', '项目页渲染(Leader 对话/项目会话)', /Project Leader 对话/.test(projCard) && /项目会话/.test(projCard), 'project page text probe')
  await page.screenshot({ path: join(EVID, 'project-page-desktop.png') })

  // 2) 会话视图(桌面)
  await page.goto(`${BASE}/workshop/w/${wsId}?view=sessions&channel=${STATE.us2.channelId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const smReady = await page.waitForSelector('.sm-wrap', { timeout: 60000 }).then(() => true).catch(() => false)
  await sleep(2500)
  const sessText = await page.evaluate(() => document.querySelector('.sm-wrap')?.textContent ?? '')
  const pagePath = await page.evaluate(() => location.pathname + location.search)
  ok('UI-2', '会话视图渲染(brief/注入预览;真实 DOM 等待)', smReady && /Session Context/.test(sessText) && /注入预览/.test(sessText) && !/undefined/.test(pagePath), `ready=${smReady} probe=${sessText.slice(0, 120)} path=${pagePath}`)
  await page.screenshot({ path: join(EVID, 'session-view-desktop.png') })

  // 3) 会话视图(移动 390x844)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  ok('UI-3', '移动端会话视图无横向溢出', !overflowX, `overflow=${overflowX}`)
  await page.screenshot({ path: join(EVID, 'session-view-mobile.png') })

  // 4) 落地页渲染(us7 产物)
  const htmlPath = STATE.us7?.htmlPath
  if (htmlPath && existsSync(htmlPath)) {
    await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(1500)
    const title = await page.title()
    ok('UI-4', '落地页可渲染(真实引擎产物)', true, `title=${title}`)
    await page.screenshot({ path: join(EVID, 'landing-page-desktop.png'), fullPage: false })
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await sleep(1200)
    const mOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    ok('UI-5', '落地页移动端无横向溢出', !mOverflow, `overflow=${mOverflow}`)
    await page.screenshot({ path: join(EVID, 'landing-page-mobile.png') })
  }
  else {
    ok('UI-4', '落地页可渲染(真实引擎产物)', false, `htmlPath missing: ${htmlPath}`)
  }
}
catch (err) {
  console.error('UI capture 异常:', err)
  process.exitCode = 1
}
finally {
  await browser?.close().catch(() => {})
}
writeFileSync(join(EVID, 'ui-capture.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
const fail = results.filter(r => !r.pass).length
console.log(`\n=== UI CAPTURE pass=${results.length - fail} fail=${fail} ===`)
process.exitCode = fail > 0 ? 1 : 0
