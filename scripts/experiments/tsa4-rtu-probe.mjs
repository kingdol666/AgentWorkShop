// tsa4 round — RTU pool pending-leak regression probe (DEF-20261120-RTU-POOL-PENDING).
// Subject: cooling-loop (modbus-rtu) nodes 冷却流量SP / 模具温度PV on line ln-a80dfb0d.
// Defect claim (TSA3): driver pool sample() returns null silently when conn.pending > 8 and
// never evicts → node permanently offline with zero logs. This probe:
//   1) baseline sequential reads,
//   2) concurrent burst (12 > pending limit) to build pending pressure,
//   3) post-burst sequential reads + health/status observation,
//   4) honest verdict: does v0.14.0 still wedge silently, and does any new observability
//      surface (dependency-health is NOT yet wired to device drivers — module-level only) report it?
// NOTE: known operational recovery (from TSA3) if wedged: point driverConfig.port at a dead
// port to trigger 3 error-strikes eviction, then restore. Applied manually after this probe.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))
const log = m => console.log(`[tsa4-rtu] ${m}`)

async function api(method, path, body, timeoutMs = 45_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) }
  catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

const agg = await api('GET', '/api/workshop/dcw')
const nodes = agg.json?.data?.nodes ?? []
const rtu = nodes.filter(n => /冷却流量|模具温度/.test(String(n.name ?? '')))
save('rtu-nodes.json', rtu.map(n => ({ id: n.id, name: n.name, value: n.value, online: n.online ?? n.status })))
if (rtu.length === 0) throw new Error('RTU nodes not found')
const ids = rtu.map(n => n.id)
log(`rtu nodes: ${rtu.map(n => `${n.name}=${n.value}`).join(', ')}`)

// 1) baseline sequential
const baseline = []
for (const id of ids) {
  const r = await api('POST', `/api/workshop/dcw/${id}/read`, {})
  baseline.push({ id, status: r.status, value: r.json?.data?.read?.value ?? null })
}
save('rtu-baseline.json', baseline)
log(`baseline: ${baseline.map(b => `${b.id.slice(0, 8)}=${b.value ?? 'null'}(${b.status})`).join(' ')}`)

// 2) concurrent burst 12 reads per node (pending pressure > 8)
const burst = []
const t0 = Date.now()
for (let round = 0; round < 3; round++) {
  const jobs = []
  for (const id of ids) for (let i = 0; i < 12; i++) jobs.push(api('POST', `/api/workshop/dcw/${id}/read`, {}, 30_000))
  const rs = await Promise.all(jobs)
  burst.push({ round, statuses: rs.map(r => r.status), nullValues: rs.filter(r => r.json?.data?.read?.value == null).length, errors: rs.filter(r => r.status === 0).length })
}
save('rtu-burst.json', { elapsedMs: Date.now() - t0, rounds: burst })
log(`burst: ${JSON.stringify(burst)}`)

// 3) post-burst sequential reads (immediately + after settle)
await sleep(3000)
const post = []
for (const id of ids) {
  const r = await api('POST', `/api/workshop/dcw/${id}/read`, {})
  post.push({ id, status: r.status, value: r.json?.data?.read?.value ?? null })
}
await sleep(10_000)
const postLate = []
for (const id of ids) {
  const r = await api('POST', `/api/workshop/dcw/${id}/read`, {})
  postLate.push({ id, status: r.status, value: r.json?.data?.read?.value ?? null })
}
save('rtu-post-burst.json', { post, postLate })
const agg2 = await api('GET', '/api/workshop/dcw')
const rtu2 = (agg2.json?.data?.nodes ?? []).filter(n => ids.includes(n.id))
save('rtu-after.json', rtu2.map(n => ({ id: n.id, name: n.name, value: n.value, online: n.online ?? n.status })))

const allNullLate = postLate.every(p => p.value == null)
const wedged = allNullLate
log(`post-burst: ${post.map(p => `${p.id.slice(0, 8)}=${p.value ?? 'null'}(${p.status})`).join(' ')}`)
log(`post-late:  ${postLate.map(p => `${p.id.slice(0, 8)}=${p.value ?? 'null'}(${p.status})`).join(' ')} wedged=${wedged}`)
console.log('TSA4-RTU-RESULT ' + JSON.stringify({ wedged, baselineOk: baseline.every(b => b.value != null), burstRounds: burst.length }))
