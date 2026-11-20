// tsa4 bench gate follow-up: shadow → active with CLIENT-provenanced bench run.
// Expected: BENCH_NOT_HOST_PROVENANCED rejection (host-provenance release gate).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
mkdirSync(EV, { recursive: true })
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const BASE = 'http://127.0.0.1:3021'
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const RUN = process.argv[2]
const PROF = process.argv[3]
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + TOKEN }, body: b ? JSON.stringify(b) : undefined, signal: AbortSignal.timeout(30_000) }); return { s: r.status, j: await r.json().catch(() => ({})) } }
const a = await api('POST', `/api/workshop/channels/${CH}/harness-profiles/promote`, { profileId: PROF, to: 'active', benchRunId: RUN })
const out = { activeFromShadowWithClientRun: { s: a.s, body: a.j?.data ?? a.j } }
writeFileSync(join(EV, 'bench-promote-active-hostgate.json'), JSON.stringify(out, null, 1))
const body = out.activeFromShadowWithClientRun.body
const held = body?.ok === false || a.s >= 400
console.log('HOSTGATE ' + JSON.stringify({ held, status: a.s, reasons: body?.reasons ?? body }))
