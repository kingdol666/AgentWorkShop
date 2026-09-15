/**
 * Canonical walkthrough-figure capture. High-DPI (3x), element/row-accurate crops
 * of the four operational stages on a live AgentWorkShop instance.
 *
 * Usage: NO_PROXY='127.0.0.1,localhost' AW_BASE=http://127.0.0.1:3005 node scripts/capture-walkthrough.mjs
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const OUT = process.env.AW_OUT ?? 'paper/tii/figures/walkthrough'
fs.mkdirSync(OUT, { recursive: true })

const tok = async (e, p) => {
  const r = await (await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()
  if (!r.data?.token) throw new Error(`login failed: ${e} (${JSON.stringify(r).slice(0, 120)})`)
  return r.data.token
}
const ADMIN = await tok('admin@awshop.local', 'admin123')
const VISUAL = await tok('visual@awshop.local', 'Visual2026')

const browser = await puppeteer.launch({
  executablePath: process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--proxy-server=direct://', '--proxy-bypass-list=*'],
})
const page = await browser.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e).slice(0, 120)))
await page.setViewport({ width: 1680, height: 1600, deviceScaleFactor: 3 })

const auth = async (t) => { const c = await page.target().createCDPSession(); await c.send('Network.clearBrowserCookies'); await page.setCookie({ name: 'token', value: t, domain: '127.0.0.1', path: '/' }) }
const goto = async (u, w = 10000) => { await page.goto(`${BASE}${u}`, { waitUntil: 'domcontentloaded', timeout: 90_000 }); await new Promise(r => setTimeout(r, w)) }
const shot = async (n, x, y, w, h) => {
  await page.screenshot({ path: path.join(OUT, n), clip: { x, y, width: w, height: h }, captureBeyondViewport: true })
  console.log(`  ✓ ${n}  ${w}x${Math.round(h)} css @3x`)
}

// ── workspace / line discovery ───────────────────────────────────────────
const WS = (await (await fetch(`${BASE}/api/workshop/workspaces`, { headers: { Authorization: `Bearer ${VISUAL}` } })).json()).data[0].id
const LINES = (await (await fetch(`${BASE}/api/workshop/dcw/lines`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()).data.lines
const LINE = LINES.find(l => l.name === '1号产线')?.id ?? LINES[0].id
console.log(`workspace=${WS}  line=${LINE} (${LINES.find(l => l.id === LINE)?.name})`)

// ══ ① provision & connect ════════════════════════════════════════════════
console.log('\n== ① /daq ==')
await auth(ADMIN); await goto('/daq', 12000)
await page.evaluate((ln) => {
  for (const s of document.querySelectorAll('select')) {
    const o = [...s.options].find(o => o.value === ln)
    if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); break }
  }
}, LINE)
await new Promise(r => setTimeout(r, 4500))

const G = await page.evaluate(() => {
  const tbl = document.querySelector('.nodes-table')
  const rect = tbl.getBoundingClientRect(), tx = rect.x
  const col = {}; [...tbl.querySelectorAll('thead th')].forEach(t => col[t.textContent.trim()] = Math.round(t.getBoundingClientRect().x - tx))
  const rows = [...tbl.querySelectorAll('tbody tr')].map((tr) => { const q = tr.getBoundingClientRect(); return { y: q.y + window.scrollY, h: q.height, name: (tr.querySelector('b')?.textContent || '').trim(), driver: (tr.querySelector('td:nth-last-child(6)')?.textContent || '').trim() } })
  return { x: tx, rows, col }
})
// pick the row pair: a mock node and the real modbus-tcp node
const mb = G.rows.findIndex(r => r.driver.includes('modbus-tcp'))
// the mock-sampling row immediately above the real Modbus row → a 2-row pair
let mk = mb > 0 ? mb - 1 : G.rows.findIndex(r => r.driver === 'mock')
console.log(`  pairs: row ${mk} (${G.rows[mk]?.name} / ${G.rows[mk]?.driver}), row ${mb} (${G.rows[mb]?.name} / ${G.rows[mb]?.driver})`)
const yS = G.rows[mk].y, yE = G.rows[mb].y + G.rows[mb].h, HH = yE - yS
await shot('p1-nodes.png', G.x, yS, 460, HH)
await shot('p1-driver.png', G.x + G.col['采样周期'], yS, 460, HH)
const C = await page.evaluate(() => { const e = document.querySelector('.aw-tile.ctrl-card'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height } })
await shot('p1-addnode.png', C.x + C.w - 470, C.y + 10, 460, C.h - 20)

// ══ ④ governed closed loop ══════════════════════════════════════════════
console.log('\n== ④ /daq Agent 优化记录 ==')
await page.evaluate(() => document.querySelector('.opt-head')?.click())
await new Promise(r => setTimeout(r, 3200))
const O = await page.evaluate(() => {
  const e = document.querySelector('.opt-card'); const r = e.getBoundingClientRect()
  const rows = [...e.querySelectorAll('.opt-row')].map(x => { const q = x.getBoundingClientRect(); return { y: Math.round(q.y + window.scrollY), h: Math.round(q.height), st: (x.querySelector('.opt-status')?.textContent || '').trim() } })
  return { x: r.x, y: r.y + window.scrollY, rows }
})
console.log('  opt rows:', JSON.stringify(O.rows.slice(0, 5)))
const judgedIdx = O.rows.findIndex(r => r.st.includes('已判定'))
await shot('p4-optrec.png', O.x, O.y, 680, (O.rows[Math.max(judgedIdx, 2)].y + O.rows[Math.max(judgedIdx, 2)].h + 8) - O.y)
if (judgedIdx >= 0) await shot('p4-verdict.png', O.x, O.rows[judgedIdx].y - 6, 960, O.rows[judgedIdx].h + 20)

// ══ ② binding ═══════════════════════════════════════════════════════════
console.log('\n== ② /dcw/' + LINE + ' ==')
await goto(`/dcw/${LINE}`, 12000)
const D = await page.evaluate(() => {
  const t = document.querySelector('.aw-tile.table-card table'); const r = t.getBoundingClientRect(), tx = r.x
  const col = {}; [...t.querySelectorAll('thead th')].forEach(x => col[x.textContent.trim()] = Math.round(x.getBoundingClientRect().x - tx))
  return { x: tx, y: r.y + window.scrollY, h: r.height, col }
})
await shot('p2-binding.png', D.x + D.col['绑定设备'] - 250, D.y, 520, D.h)
await shot('p2-setpoint.png', D.x + D.col['当前设定'], D.y, 500, D.h)
// ledger
await page.evaluate(() => { const s = document.querySelector('.ledger-card select.inp'); const o = s && [...s.options].find(o => o.value); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')) } })
await new Promise(r => setTimeout(r, 3200))
const L = await page.evaluate(() => { const e = document.querySelector('.ledger-card'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, h: r.height } })
await shot('p4-ledger.png', L.x, L.y, 680, Math.min(L.h, 250))
console.log('  ledger text:', await page.evaluate(() => document.querySelector('.ledger-cols')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160)))

// ══ ③ agent team ════════════════════════════════════════════════════════
console.log('\n== ③ /workshop ==')
await auth(VISUAL)
await goto('/workshop/teams', 9000)
const cards = await page.evaluate(() => [...document.querySelectorAll('.grid .card')].map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), t: e.textContent.replace(/\s+/g, ' ').slice(0, 24) } }))
console.log('  cards', JSON.stringify(cards))
const tgt = cards.find(c => c.t.includes('AML')) ?? cards[cards.length - 1]
await shot('p3-team.png', tgt.x - 5, tgt.y - 5, 425, tgt.h + 10)
const hd = await page.evaluate(() => { const e = document.querySelector('.head'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, h: r.height } })
await shot('p3-teams-head.png', hd.x, hd.y, 820, hd.h + 16)

await goto(`/workshop/w/${WS}?view=lanes`, 13000)
const comp = await page.evaluate(() => { const e = document.querySelector('.composer-box'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, h: r.height } })
const bar = await page.evaluate(() => { const e = document.querySelector('.lanes-wrap .toolbar'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height } })
await shot('p3-composer.png', comp.x, comp.y, 680, comp.h)
await shot('p3-lanes-bar.png', bar.x, bar.y - 3, bar.w, bar.h + 6)
const lane = await page.evaluate(() => { const e = document.querySelector('.lane'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + window.scrollY, w: r.width } })
await shot('p3-lane.png', lane.x, lane.y, lane.w * 2 + 8, 200)

console.log('\npageerrors:', errs.length ? errs.join(' | ') : 'none')
await browser.close()
