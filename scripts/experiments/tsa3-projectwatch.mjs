// tsa3 round — wait for G4/G5 work items to reach terminal states; poll every 60s up to 50min.
import { writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3021'
const TOKEN = process.env.AW_TOKEN
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(`D:/tmp/aw-liv3-1120/${name}`, JSON.stringify(obj, null, 1))

async function items(pid) {
  const r = await fetch(`${BASE}/api/workshop/projects/${pid}/work-items`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) })
  const j = await r.json().catch(() => ({}))
  const d = j.data
  return Array.isArray(d) ? d : (d?.items ?? [])
}

const G4 = '87407519-2508-4f40-82a6-e729fc6ce9c0'
const G5 = '26389929-f571-4670-b235-d04445764e60'
const terminal = (s) => ['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED'].includes(String(s).toUpperCase())

const t0 = Date.now()
let last = ''
while (Date.now() - t0 < 50 * 60_000) {
  const [g4, g5] = await Promise.all([items(G4), items(G5)])
  const active = [...g4, ...g5].filter(w => !terminal(w.state) && w.state !== 'DRAFT')
  const sig = JSON.stringify([g4.map(w => [w.title?.slice(0, 12), w.state]), g5.map(w => [w.title?.slice(0, 12), w.state])])
  if (sig !== last) { last = sig; save('projects-watch.json', { at: new Date().toISOString(), g4: g4.map(w => ({ t: w.title?.slice(0, 30), s: w.state })), g5: g5.map(w => ({ t: w.title?.slice(0, 30), s: w.state })) }) }
  const g4Active = g4.some(w => String(w.title).includes('R2s') && !terminal(w.state))
  const g4Last = g4.find(w => String(w.title).includes('基于 R1s+R2s'))
  const g5Impl = g5.find(w => String(w.title).includes('landing-page.html'))
  const done = !g4Active && (!g4Last || terminal(g4Last.state)) && (!g5Impl || terminal(g5Impl.state) || g5Impl.state === 'DRAFT' && Date.now() - t0 > 40 * 60_000)
  if (done) { console.log('WATCH-DONE', JSON.stringify({ g4: g4.map(w => [w.title?.slice(0, 18), w.state]), g5: g5.map(w => [w.title?.slice(0, 18), w.state]) })); break }
  await sleep(60_000)
}
console.log('watch exit')
