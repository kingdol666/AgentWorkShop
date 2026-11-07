#!/usr/bin/env node
/** UI-1/4/5 断言脚本化(评审整改):项目页 DOM 探针 + 落地页渲染/移动溢出。 */
import puppeteer from 'puppeteer-core'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-e2e-landing')
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const STATE = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'e2e-state.json'), 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let results = (JSON.parse(readFileSync(join(EVID, 'ui-capture.json'), 'utf8')).results ?? []).filter(r => !['UI-1', 'UI-4', 'UI-5'].includes(r.id))
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 240)}`}`)
}
const save = () => writeFileSync(join(EVID, 'ui-capture.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, results }, null, 2))
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
const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  // UI-1 项目页
  await page.goto(`${BASE}/projects/${STATE.us3.projectId}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await sleep(3500)
  const projText = await page.evaluate(() => document.body.textContent ?? '')
  ok('UI-1', '项目页渲染(Leader 对话/项目会话/快照面板)', /Project Leader 对话/.test(projText) && /项目会话/.test(projText), 'DOM probe')
  await page.screenshot({ path: join(EVID, 'project-page-desktop.png') })
  save()
  // UI-4/5 落地页
  await page.goto(pathToFileURL(join(EVID, 'landing-page.html')).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(1500)
  const landText = await page.evaluate(() => document.body.textContent ?? '')
  ok('UI-4', '落地页可渲染(真实引擎文案产物;hero/卖点/FAQ/CTA)', /入耳即译/.test(landText) && /为什么带上它出差/.test(landText) && /常见问题/.test(landText) && /立即入手/.test(landText), 'DOM probe')
  await page.screenshot({ path: join(EVID, 'landing-page-desktop.png') })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(1200)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  ok('UI-5', '落地页移动端(390x844)无横向溢出', !overflow, `overflow=${overflow}`)
  await page.screenshot({ path: join(EVID, 'landing-page-mobile.png') })
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
console.log(`\n=== PAGE CAPTURE pass=${results.length - fail} fail=${fail} ===`)
process.exitCode = fail > 0 ? 1 : 0
