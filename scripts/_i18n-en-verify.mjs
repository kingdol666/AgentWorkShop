// EN-mode i18n verification: seed minimal EN-named data, visit every route,
// scan rendered innerText for residual CJK (missing translations), screenshot each page.
//   AW_BASE=http://127.0.0.1:3311 node scripts/_i18n-en-verify.mjs [--out .e2e-shots/i18n-en]
import fs from 'node:fs'
import path from 'node:path'
import { ensureVisualUser, api, launch, openPage, gotoReady, sleep, ROUTES } from './ui/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const OUT = arg('out', '.e2e-shots/i18n-en')
fs.mkdirSync(OUT, { recursive: true })

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/

const token = await ensureVisualUser()
console.log('token ok')

// ---- seed minimal EN-named data (idempotent by name) ----
let wsId
const wsList = await api('GET', '/api/workshop/workspaces', { token })
const wss = wsList.data?.workspaces ?? wsList.data ?? []
let ws = Array.isArray(wss) ? wss.find(w => w.name === 'Demo Factory') : null
if (!ws) {
  const r = await api('POST', '/api/workshop/workspaces', { body: { name: 'Demo Factory' }, token })
  ws = r.data
}
wsId = ws?.id ?? ws?.workspaceId
console.log('workspace:', wsId)

const chList = await api('GET', '/api/workshop/channels', { token })
const all = chList.data?.channels ?? chList.data ?? []
let ch = Array.isArray(all) ? all.find(c => c.name === 'demo-extrusion') : null
if (!ch) {
  const r = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'demo-extrusion',
      scenarioPrompt: 'Demo scenario prompt for i18n verification.',
      leadAgent: { name: 'demo-lead', harness: 'mock', config: { delayMs: 200, streamDemo: true } },
    },
    token,
  })
  ch = r.data
}
const cid = ch?.channelId ?? ch?.id
if (wsId && cid) await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, { token })
console.log('channel:', cid)

// ---- browser pass ----
const browser = await launch({ width: 1440, height: 900 })
const report = []

async function visit(page, { routePath, name, wait = 3500 }) {
  const errs = []
  const shot = (routePath || 'root').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60)
  page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)))
  try {
    await gotoReady(page, routePath, { wait })
    await sleep(500)
    const text = await page.evaluate(() => document.body.innerText)
    const cjkLines = text.split('\n').map(l => l.trim()).filter(l => CJK.test(l))
    await page.screenshot({ path: path.join(OUT, `${name || shot}.png`) })
    report.push({ routePath, name: name || shot, cjk: cjkLines.length, lines: cjkLines.slice(0, 12), errors: errs })
    console.log(`[${cjkLines.length === 0 ? 'PASS' : 'CJK!'}] ${routePath} (${cjkLines.length} cjk lines)`)
    if (cjkLines.length) console.log('   ' + cjkLines.slice(0, 8).join(' | ').slice(0, 400))
    if (errs.length) console.log('   pageerror:', errs.slice(0, 3).join(' / '))
  }
  catch (e) {
    report.push({ routePath, name: name || shot, error: String(e).slice(0, 300) })
    console.log(`[ERR] ${routePath}: ${String(e).slice(0, 200)}`)
  }
}

const mainPage = await openPage(browser, { token, dark: true, width: 1440, height: 900 })
// restore locale before any app script runs
await mainPage.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('aw.locale', 'en')
  }
  catch { /* about:blank 无 origin,忽略 */ }
})

for (const r of ROUTES) {
  await visit(mainPage, { routePath: r.path, name: r.name })
}
// workspace view (needs wsId)
if (wsId) await visit(mainPage, { routePath: `/workshop/w/${wsId}`, name: 'ws_view', wait: 5000 })

// login card (unauthenticated, fresh page without token cookie)
const anon = await browser.newPage()
await anon.setViewport({ width: 1440, height: 900 })
await anon.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('aw.locale', 'en')
    localStorage.setItem('app', JSON.stringify({ isDark: true, sidebarCollapsed: false, accent: null, themeTouched: true }))
  }
  catch { /* about:blank 无 origin,忽略 */ }
})
await visit(anon, { routePath: '/workshop', name: 'login_card' })
await anon.close()

await browser.close()
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const bad = report.filter(r => (r.cjk ?? 0) > 0 || r.error)
console.log(`\nDONE: ${report.length} pages, ${bad.length} with CJK/errors → ${OUT}/report.json`)
