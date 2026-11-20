// tsa4 round — governed evaluation gate live (v0.14.0):
// 1) record a paired bench run from REAL measured tuning windows (client-provenanced evidence);
// 2) negative: promote→active WITHOUT benchRunId must be rejected;
// 3) negative: promote→active WITH client benchRunId must be rejected (host provenance gate);
// 4) positive: promote→shadow with the bench run must succeed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const log = m => console.log(`[tsa4-bench] ${m}`)
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(method, path, body, timeoutMs = 30_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) }
  catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

// ---- profiles: list or create ----
const profiles = await api('GET', `/api/workshop/channels/${CH}/harness-profiles`)
let plist = profiles.json?.data?.items ?? profiles.json?.data ?? []
if (!Array.isArray(plist)) plist = []
save('bench-profiles-before.json', plist.map(p => ({ id: p.id, name: p.name, state: p.state ?? p.status })))
let profile = plist[0]
if (!profile) {
  const created = await api('POST', `/api/workshop/channels/${CH}/harness-profiles`, {
    name: `tsa4-gate-check-${Date.now().toString(36)}`,
    description: 'v0.14.0 治理门实机验证 profile(真实调参窗口测量)',
  })
  save('bench-profile-created.json', { status: created.status, body: created.json?.data ?? created.json })
  profile = created.json?.data?.profile ?? created.json?.data
  if (!profile?.id) throw new Error(`profile create failed: ${JSON.stringify(created.json).slice(0, 250)}`)
}
log(`profile=${profile.id}`)

// ---- perSeed from REAL measured tuning windows ----
// Each row = one governed tuning event on this line: a = pre-write window weight deviation from
// target (32.50g, |g|), b = post-write window deviation, cost = normalized settle latency proxy
// (steps taken). Numbers are real readback/measured values from TSA3/TSA4 rounds (see evidence).
// rows deliberately include a worsening pair — the gate must decide on the whole set, not our hope.
const target = 32.5
const windows = [
  { seed: 1, label: 'tsa3-smoke', pre: 31.03, post: 32.58, steps: 1 },
  { seed: 2, label: 'tsa4-R1', pre: 32.58, post: 32.46, steps: 1 },
  { seed: 3, label: 'tsa4-R2', pre: 32.46, post: 32.71, steps: 1 },
]
const perSeed = windows.map(w => ({ seed: w.seed, a: Math.abs(w.pre - target), b: Math.abs(w.post - target), costA: 1, costB: w.steps }))
const meanA = perSeed.reduce((s, r) => s + r.a, 0) / perSeed.length
const meanB = perSeed.reduce((s, r) => s + r.b, 0) / perSeed.length
const primaryDelta = Math.round((meanA - meanB) * 1e6) / 1e6
const costDelta = 0

const rec = await api('POST', `/api/workshop/channels/${CH}/harness-bench-runs`, {
  profileId: profile.id,
  perSeed,
  primaryDelta,
  costDelta,
  seeds: perSeed.map(r => r.seed),
})
save('bench-record.json', { status: rec.status, body: rec.json?.data ?? rec.json })
if (rec.status !== 200) throw new Error(`bench run record failed: ${JSON.stringify(rec.json).slice(0, 300)}`)
const runId = rec.json?.data?.runId ?? rec.json?.data?.id ?? rec.json?.data?.run?.id
log(`bench run recorded runId=${runId} primaryDelta=${primaryDelta}`)

// falsified-summary negative: self-reported primaryDelta inconsistent with perSeed → must reject
const falsified = await api('POST', `/api/workshop/channels/${CH}/harness-bench-runs`, {
  profileId: profile.id,
  perSeed,
  primaryDelta: 99,
  costDelta,
})
save('bench-falsified-negative.json', { status: falsified.status, code: falsified.json?.code, reasons: falsified.json?.message ?? falsified.json?.data })
log(`falsified summary rejected=${falsified.status !== 200} (status=${falsified.status})`)

// ---- gate negatives ----
const noRun = await api('POST', `/api/workshop/channels/${CH}/harness-profiles/promote`, { profileId: profile.id, to: 'active' })
save('bench-promote-active-no-run.json', { status: noRun.status, code: noRun.json?.code, body: noRun.json?.data ?? noRun.json })
log(`promote→active without run: status=${noRun.status} (expect 4xx)`)

const withClientRun = await api('POST', `/api/workshop/channels/${CH}/harness-profiles/promote`, { profileId: profile.id, to: 'active', benchRunId: runId })
save('bench-promote-active-client-run.json', { status: withClientRun.status, code: withClientRun.json?.code, body: withClientRun.json?.data ?? withClientRun.json })
const gateHeld = withClientRun.status !== 200
log(`promote→active with CLIENT run: status=${withClientRun.status} code=${withClientRun.json?.code ?? '-'} (host-provenance gate ${gateHeld ? 'HELD' : 'DID NOT HOLD'})`)

// ---- shadow promotion (client evidence is admissible for shadow) ----
const shadow = await api('POST', `/api/workshop/channels/${CH}/harness-profiles/promote`, { profileId: profile.id, to: 'shadow', benchRunId: runId })
save('bench-promote-shadow.json', { status: shadow.status, body: shadow.json?.data ?? shadow.json })
log(`promote→shadow: status=${shadow.status}`)

console.log('TSA4-BENCH-RESULT ' + JSON.stringify({ runId, primaryDelta, falsifiedRejected: falsified.status !== 200, activeGateHeld: gateHeld, activeCode: withClientRun.json?.code ?? null, shadowStatus: shadow.status }))
