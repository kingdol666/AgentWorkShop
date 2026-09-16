/**
 * Canonical walkthrough-figure capture. High-DPI (3x), element/row-accurate crops
 * of the four operational stages on a live AgentWorkShop instance.
 *
 * The shared production instance carries Chinese-named test data, so the four
 * screenshots are taken against the small ENGLISH fixture created by
 * scripts/seed-walkthrough-fixture.mjs (line "Cast-film line A", English DAQ
 * nodes, an English agent team). The UI is forced to the `en` locale (persisted
 * in localStorage under `aw.locale`, applied by app/plugins/locale-restore.client.ts)
 * before any capture, so every UI string is English.
 *
 * Geometry discipline: every crop is ≤470 CSS px wide (12 px UI text must print
 * ≥ ~6.4 pt at the ~88 mm panel width of the 181 mm figure), except panel 2 whose
 * four table columns cannot fit narrower.
 *
 * Usage:
 *   NO_PROXY='127.0.0.1,localhost' node scripts/seed-walkthrough-fixture.mjs
 *   NO_PROXY='127.0.0.1,localhost' AW_BASE=http://127.0.0.1:3005 node scripts/capture-walkthrough.mjs
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const OUT = process.env.AW_OUT ?? 'paper/tii/figures/walkthrough'
fs.mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const tok = async (e, p) => {
  const r = await (await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e, password: p }) })).json()
  if (!r.data?.token) throw new Error(`login failed: ${e} (${JSON.stringify(r).slice(0, 120)})`)
  return r.data.token
}
const ADMIN = await tok('admin@awshop.local', 'admin123')

const jget = async (u) => {
  const r = await (await fetch(`${BASE}${u}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()
  return r.data
}

// ── fixture discovery (fail loudly rather than silently capturing Chinese) ──
const LINES = (await jget('/api/workshop/dcw/lines')).lines
const LINE = LINES.find(l => l.name === 'Cast-film line A')
if (!LINE) throw new Error('English fixture line "Cast-film line A" missing — run scripts/seed-walkthrough-fixture.mjs first')
const DAQ = await jget('/api/workshop/daq')
const modbusNode = DAQ.nodes.find(n => n.lineId === LINE.id && n.driver === 'modbus-tcp')
if (!modbusNode) throw new Error('fixture Modbus-TCP node missing on Cast-film line A')
// panel 4 uses the real judged optimization records already on the ledger of this node
const RECORD_LINE = 'ln-af002514'
const RECORD_NODE = 'dw-322b1978'
console.log(`fixture line=${LINE.id}  modbus=${modbusNode.id} (${modbusNode.name})  records=${RECORD_NODE}`)

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
const goto = async (u, w = 10000) => { await page.goto(`${BASE}${u}`, { waitUntil: 'domcontentloaded', timeout: 90_000 }); await sleep(w) }

// content-visibility:auto sections report estimated rects until rendered; force real
// layout so element-accurate clips do not drift. Also kill CSS transitions/animations
// so a mid-transition frame (e.g. the hold-interval cell double-painting its value)
// can never be captured.
const settle = async () => {
  await page.evaluate(() => {
    let st = document.getElementById('aw-capture-calm')
    if (!st) {
      st = document.createElement('style')
      st.id = 'aw-capture-calm'
      st.textContent = '*,*::before,*::after{transition:none!important;transition-duration:0s!important;animation:none!important;animation-duration:0s!important;animation-delay:0s!important}'
      document.head.appendChild(st)
    }
    for (const e of document.querySelectorAll('*')) {
      const cs = getComputedStyle(e)
      if (cs.contentVisibility && cs.contentVisibility !== 'visible') e.style.contentVisibility = 'visible'
    }
    window.scrollTo(0, document.body.scrollHeight)
  })
  await sleep(700)
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(300)
}

// Grow the viewport to the full document height BEFORE measuring, so that the
// screenshot's captureBeyondViewport expansion cannot re-layout the page and
// shift elements between measurement and capture.
const expand = async () => {
  const h = await page.evaluate(() => document.documentElement.scrollHeight)
  await page.setViewport({ width: 1680, height: Math.min(Math.ceil(h) + 40, 14000), deviceScaleFactor: 3 })
  await sleep(1200)
  await settle()
}

const repaint = async () => {
  await page.evaluate(() => new Promise(res => {
    window.scrollTo(0, 0)
    requestAnimationFrame(() => requestAnimationFrame(res))
  }))
  await sleep(120)
}

// Capture only once the pixels stop changing: two consecutive identical captures are
// required (guards against mid-transition / late-commit frames like double-struck text).
const shot = async (n, x, y, w, h, tries = 5) => {
  const clip = { x, y, width: w, height: h }
  let prev = null
  let stable = false
  for (let i = 0; i < tries; i++) {
    await repaint()
    const buf = Buffer.from(await page.screenshot({ encoding: 'binary', clip, captureBeyondViewport: true }))
    if (prev && Buffer.compare(prev, buf) === 0) { prev = buf; stable = true; break }
    prev = buf
    await sleep(1000)
  }
  fs.writeFileSync(path.join(OUT, n), prev)
  console.log(`  ✓ ${n}  ${Math.round(w)}x${Math.round(h)} css @3x  ${stable ? 'stable' : 'NOT STABLE (last frame written)'}`)
}

// ── force English UI before any capture ──────────────────────────────────
await auth(ADMIN)
await goto('/daq', 4000)
await page.evaluate(() => localStorage.setItem('aw.locale', 'en'))
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(6000)
const heads = await page.evaluate(() => [...document.querySelectorAll('.nodes-table thead th')].map(t => t.textContent.trim()))
if (!heads.some(h => /Sampling/i.test(h))) throw new Error(`locale not English (headers: ${JSON.stringify(heads)})`)
console.log(`locale  : en (headers: ${heads.join(' | ')})`)

// ══ ① provision & connect — /daq nodes filtered to the English line ══════
console.log('\n== ① /daq ==')
await page.evaluate((ln) => {
  for (const s of document.querySelectorAll('select')) {
    if ([...s.options].some(o => o.value === ln)) { s.value = ln; s.dispatchEvent(new Event('change', { bubbles: true })); break }
  }
}, LINE.id)
await sleep(3500)
await settle()
await expand()

const G = await page.evaluate(() => {
  const tbl = document.querySelector('.nodes-table')
  const rect = tbl.getBoundingClientRect()
  const ths = [...tbl.querySelectorAll('thead th')].map(t => ({ x: Math.round(t.getBoundingClientRect().x - rect.x), text: t.textContent.trim() }))
  const rows = [...tbl.querySelectorAll('tbody tr')].map((tr) => {
    const q = tr.getBoundingClientRect()
    const tds = tr.querySelectorAll('td')
    return { y: Math.round(q.y + window.scrollY), h: q.height, name: (tr.querySelector('b')?.textContent || '').trim(), driver: (tds[6]?.textContent || '').trim() }
  })
  return { x: rect.x, ths, rows }
})
console.log('  rows:', G.rows.map(r => `${r.name}[${r.driver}]`).join(', '))
if (!G.rows.some(r => r.driver.includes('modbus'))) throw new Error('no Modbus-TCP row visible on filtered line')
// columns: 4 Sampling · 5 WS Publish · 6 Driver · 7 Line (indices are locale-stable).
// Keep the crop ≤470 css px: 12 px UI text must print ≥ ~6.4 pt at the 88 mm panel width.
const mbIdx = G.rows.findIndex(r => r.driver.includes('modbus'))
const mkIdx = mbIdx > 0 ? mbIdx - 1 : 0
const x0 = G.x + G.ths[4].x
const x1 = G.x + G.ths[8].x
const yS = G.rows[mkIdx].y
const yE = G.rows[mbIdx].y + G.rows[mbIdx].h
console.log(`  pair: ${G.rows[mkIdx].name}[${G.rows[mkIdx].driver}] + ${G.rows[mbIdx].name}[${G.rows[mbIdx].driver}]`)
await shot('p1-driver.png', x0 - 2, yS, Math.min(x1 - x0 + 4, 470), yE - yS)

// ══ ② bind node → line / device — /dcw/{English line} ═══════════════════
console.log('\n== ② /dcw/' + LINE.id + ' ==')
await goto(`/dcw/${LINE.id}`, 9000)
await settle()
await expand()
const D = await page.evaluate(() => {
  const t = document.querySelector('.aw-tile.table-card table')
  const rect = t.getBoundingClientRect()
  const ths = [...t.querySelectorAll('thead th')].map(x => ({ x: Math.round(x.getBoundingClientRect().x - rect.x), text: x.textContent.trim() }))
  return { x: rect.x, y: rect.y + window.scrollY, h: rect.height, ths }
})
console.log('  cols:', D.ths.map(c => c.text).join(' | '))
// columns: 5 Setpoint · 6 Process Range · 7 Hold Interval · 8 Bound Device
const c0 = D.x + D.ths[5].x
const c1 = D.x + D.ths[9].x
await shot('p2-binding.png', c0 - 6, D.y, (c1 - c0) + 12, D.h)

// ══ ④ governed closed loop — ledger optimization records (real, judged) ══
console.log('\n== ④ /dcw/' + RECORD_LINE + ' ledger ==')
await goto(`/dcw/${RECORD_LINE}`, 9000)
await page.evaluate((nid) => {
  const s = document.querySelector('.ledger-card select.inp')
  if (!s) return
  s.value = nid
  s.dispatchEvent(new Event('change', { bubbles: true }))
}, RECORD_NODE)
await sleep(3500)
await settle()
await expand()
const L = await page.evaluate(() => {
  const card = document.querySelector('.ledger-card')
  const col = [...card.querySelectorAll('.ledger-col')].find(c => c.querySelector('li.ledger-rec')) || [...card.querySelectorAll('.ledger-col')].pop()
  const recs = [...col.querySelectorAll('li.ledger-rec')]
  const r = col.getBoundingClientRect()
  const last = recs[recs.length - 1].getBoundingClientRect()
  return { x: r.x, y: r.y + window.scrollY, w: r.width, h: last.bottom - r.top, texts: recs.map(li => li.textContent.replace(/\s+/g, ' ').trim()) }
})
console.log('  records:', JSON.stringify(L.texts))
// tight: header + the real records, without the empty box below them
await shot('p4-records.png', L.x - 5, L.y - 5, Math.min(L.w + 14, 470), L.h + 14)

// ══ ③ compose & deploy the agent team — /workshop/teams ═════════════════
// Desktop viewport: one card in the multi-column grid (~343 px wide), which keeps the
// crop ≤470 css px so member text prints ≥ ~6 pt at the 88 mm panel width.
console.log('\n== ③ /workshop/teams ==')
await page.setViewport({ width: 1680, height: 1600, deviceScaleFactor: 3 })
await goto('/workshop/teams', 9000)
await settle()
await expand()
const cards = await page.evaluate(() => [...document.querySelectorAll('.grid .card')].map(e => {
  const r = e.getBoundingClientRect()
  const members = e.querySelectorAll('.member')
  const last = members[members.length - 1]?.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height), memberH: last ? Math.round(last.bottom - r.top) : Math.round(r.height), t: e.textContent.replace(/\s+/g, ' ').slice(0, 40) }
}))
console.log('  cards:', JSON.stringify(cards))
const tgt = cards.find(c => c.t.includes('Cast-film control team'))
if (!tgt) throw new Error('English team card not found on /workshop/teams')
// crop head + member rows only (excludes the Add-Member button) to keep the figure compact
await shot('p3-team.png', tgt.x - 5, tgt.y - 5, Math.min(tgt.w + 10, 470), tgt.memberH + 8)

console.log('\npageerrors:', errs.length ? errs.join(' | ') : 'none')
await browser.close()
