import puppeteer from 'puppeteer-core'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-system-lifecycle')
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const st = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'lifecycle-state.json'), 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e-landing@aw.local', password: 'E2E#2026' }) }).then(r => r.json())
const token = login.data.token
const browser = await puppeteer.launch({ executablePath: process.env.AW_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 120000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'] })
const results = []
const save = () => {
  writeFileSync(join(EVID, 'ui-lifecycle-capture.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
}
const ok = (id, name, cond, detail) => {
  results.push({ id, name, pass: !!cond, detail: String(detail ?? '').slice(0, 300) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}`)
  save()
}
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  await page.goto(`${BASE}/projects/${st.L4.projectId}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await sleep(3500)
  const text = await page.evaluate(() => document.body.textContent ?? '')
  ok('UI-L1', '已完成项目页渲染(归档态+快照)', /archived|已完成|已归档/.test(text) && /项目快照/.test(text), text.slice(0, 120))
  await page.screenshot({ path: join(EVID, 'project-completed-desktop.png') })
  await page.screenshot({ path: join(EVID, 'project-completed-desktop.png'), fullPage: true })
  // 事件页
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid]')].find(x => x.getAttribute('data-testid') === 'tab-events')
    el?.click()
  })
  await sleep(1500)
  const evText = await page.evaluate(() => document.body.textContent ?? '')
  ok('UI-L2', '决策与事件页渲染(全链审计可见)', /work.dispatched|approval/.test(evText), evText.slice(0, 120))
  await page.screenshot({ path: join(EVID, 'project-events-desktop.png') })
}
finally {
  await browser.close().catch(() => {})
  writeFileSync(join(EVID, 'ui-lifecycle-capture.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
}
