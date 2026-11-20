// tsa5 round — project watcher: polls both active projects to terminal states, snapshots
// work items + planProgress (pending-card visibility + materialization evidence).
import { writeFileSync, readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3021'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const PRIVATE = 'D:/tmp/aw-liv5-1121'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(`${PRIVATE}/${name}`, JSON.stringify(obj, null, 1))

async function api(p) {
  const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) })
  const j = await r.json().catch(() => ({}))
  return { s: r.status, j }
}
const items = j => Array.isArray(j?.data) ? j.data : (j?.data?.items ?? [])

const G4 = '87407519-2508-4f40-82a6-e729fc6ce9c0'
const G5 = '26389929-f571-4670-b235-d04445764e60'
const terminal = s => ['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED'].includes(String(s).toUpperCase())

const t0 = Date.now()
let last = ''
while (Date.now() - t0 < 50 * 60_000) {
  const [g4w, g5w, g4o, g5o] = [await api(`/api/workshop/projects/${G4}/work-items`), await api(`/api/workshop/projects/${G5}/work-items`), await api(`/api/workshop/projects/${G4}/observability`), await api(`/api/workshop/projects/${G5}/observability`)]
  const a = items(g4w.j), b = items(g5w.j)
  const snap = {
    at: new Date().toISOString(),
    g4: a.map(w => ({ t: String(w.title ?? '').slice(0, 30), s: w.state })),
    g5: b.map(w => ({ t: String(w.title ?? '').slice(0, 30), s: w.state })),
    g4Plan: g4o.j?.data?.planProgress ?? null,
    g5Plan: g5o.j?.data?.planProgress ?? null,
  }
  const sig = JSON.stringify([snap.g4, snap.g5, snap.g4Plan?.pendingApprovalId, snap.g5Plan?.pendingApprovalId, snap.g4Plan?.state, snap.g5Plan?.state])
  if (sig !== last) { last = sig; save('projects-watch.json', snap) }
  const g5Impl = b.find(w => String(w.title ?? '').includes('落地页') && String(w.title ?? '').includes('实现'))
  const g4Sum = a.find(w => String(w.title ?? '').includes('结论汇总'))
  const done = (!g5Impl || terminal(g5Impl.state)) && (!g4Sum || terminal(g4Sum.state))
  if (done) { console.log('WATCH-DONE ' + JSON.stringify({ g5Impl: g5Impl?.state, g4Sum: g4Sum?.state })); break }
  await sleep(60_000)
}
console.log('watch exit')
