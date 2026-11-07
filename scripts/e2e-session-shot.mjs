#!/usr/bin/env node
/** 会话视图截图(桌面+移动)+ DOM 断言,增量写 ui-capture.json(评审整改:脚本产出,不手改)。 */
import puppeteer from 'puppeteer-core'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const STATE = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, data: null }
  }
}
let results = existsSync(join(EVID, 'ui-capture.json'))
  ? (JSON.parse(readFileSync(join(EVID, 'ui-capture.json'), 'utf8')).results ?? []).filter(r => !['UI-0', 'UI-2', 'UI-3'].includes(r.id))
  : []
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 240)}`}`)
}
const save = () => writeFileSync(join(EVID, 'ui-capture.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, results }, null, 2))

const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
let wsList = (await api('GET', '/api/workshop/workspaces', undefined, token)).data ?? []
let wsRow = wsList.find(w => (w.channelIds ?? []).includes(STATE.us2.channelId)) ?? wsList[0]
if (!wsRow) {
  const created = await api('POST', '/api/workshop/workspaces', { name: 'E2E 工作区' }, token)
  wsRow = { id: created.data?.id, channelIds: [] }
}
const wsId = wsRow.id
for (const cid of [STATE.us2.channelId, STATE.us3.A.channelId]) {
  if (!(wsRow.channelIds ?? []).includes(cid)) await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {}, token)
}
ok('UI-0', 'workspace 就绪(目标频道已挂载)', !!wsId, `wsId=${wsId}`)

const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  await page.goto(`${BASE}/workshop/w/${wsId}?view=sessions&channel=${STATE.us2.channelId}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  const smReady = await page.waitForSelector('.sm-wrap', { timeout: 45000 }).then(() => true).catch(() => false)
  await sleep(2500)
  const sessText = await page.evaluate(() => document.querySelector('.sm-wrap')?.textContent ?? '')
  ok('UI-2', '会话视图渲染(brief/注入预览;DOM 真实等待)', smReady && /Session Context/.test(sessText) && /注入预览/.test(sessText), `probe=${sessText.slice(0, 100)}`)
  await page.screenshot({ path: join(EVID, 'session-view-desktop.png') })
  save()

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sm-wrap', { timeout: 45000 }).catch(() => {})
  await sleep(2000)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  ok('UI-3', '移动端会话视图(390x844)无横向溢出', !overflow, `overflow=${overflow}`)
  await page.screenshot({ path: join(EVID, 'session-view-mobile.png') })
  save()
}
catch (err) {
  console.error('capture error:', err?.message ?? err)
  process.exitCode = 1
}
finally {
  await browser.close().catch(() => {})
}
save()
const fail = results.filter(r => !r.pass).length
console.log(`\n=== SESSION CAPTURE pass=${results.length - fail} fail=${fail} ===`)
process.exitCode = fail > 0 ? 1 : 0
