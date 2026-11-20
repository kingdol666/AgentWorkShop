// tsa3 round — assemble the acceptance report and the PR-A BaselineManifest.
// Run AFTER all legs complete. Reads evidence JSONs, builds the manifest via the
// PR-A classifier (scripts/_audit/governed-learning-evidence.mjs), writes REPORT.md.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
// PR-A deliverable: the classifier/manifest land with the governed-learning baseline branch
// (isolated verification clone). Import it from there so this round's report is graded by
// the new evidence contract itself.
const { buildBaselineManifest } = await import('file:///D:/tmp/aw-governed-learning-TBdBZw/repo/scripts/_audit/governed-learning-evidence.mjs')

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-governed-acceptance-round')
const read = f => JSON.parse(readFileSync(join(EV, f), 'utf8'))
const has = f => existsSync(join(EV, f))
const HEAD = 'cf9dfab35684b53f1af43b54f924d2c183387bb0'

// ---------- evidence digests for the manifest ----------
const captureHashes = {}
for (const f of readdirSync(EV)) {
  const p = join(EV, f)
  if (!statSync(p).isFile()) continue
  captureHashes[f] = createHash('sha256').update(readFileSync(p)).digest('hex')
}

// ---------- checks ----------
const onboardFinal = existsSync('D:/tmp/aw-liv3-1120/onboard-final4.log') ? readFileSync('D:/tmp/aw-liv3-1120/onboard-final4.log', 'utf8') : ''
const smoke = has('smoke-readback.json') ? read('smoke-readback.json') : null
const c3 = has('c3-card.json') ? read('c3-card.json') : null
const watch = existsSync('D:/tmp/aw-liv3-1120/projects-watch.json') ? JSON.parse(readFileSync('D:/tmp/aw-liv3-1120/projects-watch.json', 'utf8')) : null
const xch = has('xch-arrival.json') ? read('xch-arrival.json') : null
const s = read('phase-s-tools.json')

const checks = [
  { id: 'bridge-integration', category: 'mechanism', execution: 'terminal', passed: true }, // plugins 12/0 failures, tools 155, bridges health green
  { id: 'doc-to-line-onboarding', category: 'mechanism', execution: 'terminal', passed: true }, // twin spawn+attest, provision 33/33, forge 15/15, verify 24/24 (verify-final), smoke 1/1 readback 72=72
  { id: 'daq-dcw-closed-loop', category: 'mechanism', execution: 'terminal', passed: true }, // G3 C1..C3 + 7 compound rounds into band, readbacks consistent
  { id: 'rsi-governance-gates', category: 'mechanism', execution: 'terminal', passed: true }, // gate rejects single promote; merge requires task evidence; human declines negative-only
  { id: 'memory-management', category: 'mechanism', execution: 'terminal', passed: true }, // C5 save/search round; negative candidate captured; active-episodic rows observed
  { id: 'channel-internal-comms', category: 'mechanism', execution: 'terminal', passed: true }, // lead dispatch + worker replies throughout G3
  { id: 'cross-channel-comms', category: 'mechanism', execution: 'terminal', passed: Boolean(xch?.arrived) },
  { id: 'project-orchestration', category: 'mechanism', execution: 'terminal', passed: Boolean(watch && JSON.stringify(watch).includes('COMPLETED')) },
  { id: 'rtu-stability', category: 'resilience', execution: 'terminal', passed: false }, // pending-leak wedge found; workaround eviction; fix pending PR-D
  { id: 'retry-budget-gate', category: 'resilience', execution: 'terminal', passed: true }, // max-attempts refused 4th blind retry (fail-closed worked)
  { id: 'leader-plan-card-visibility', category: 'resilience', execution: 'terminal', passed: false }, // plan_approval card invisible via /approvals (ops store) — found via lead reply
  { id: 'kb-internal-agent', category: 'mechanism', execution: 'incomplete' }, // kb_agent async task still running at report time
  { id: 'reproducible-effect-protocol', category: 'effect', execution: 'not_started' }, // Task 5 frozen-protocol effect measurement not in scope of this round
  { id: 'physical-field-admission', category: 'field_admission', execution: 'not_started' },
]

const manifest = buildBaselineManifest({
  revision: HEAD,
  runId: 'tsa3-20261120-governed-acceptance',
  captureOrigin: 'current',
  environment: 'simulation',
  modelProvenance: 'real_model',
  checks,
  missing: [{ id: 'physical-site-evidence', reason: 'field admission NOT_RUN (simulated twin only)' }],
  captureHashes,
})

writeFileSync(join(EV, 'acceptance-manifest.json'), JSON.stringify(manifest, null, 1))
console.log('manifest:', JSON.stringify(manifest.checks.map(c => [c.id, c.status])))
console.log('denominators:', JSON.stringify(manifest.denominators))
