// tsa4 round — evidence digest: reads every JSON in the round evidence dir and emits
// REPORT.md (human-readable, four capability questions + defect regression table) and
// manifest.json (machine-checkable inventory). Update the RESULT line names as the round evolves.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-tsa4-v0140-round')
mkdirSync(EV, { recursive: true })
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const manifest = { version: VERSION, generatedAt: new Date().toISOString(), evidenceDir: 'docs/audit/evidence/2026-11-20-tsa4-v0140-round', files: {} }

const files = readdirSync(EV).filter(f => f.endsWith('.json'))
for (const f of files) {
  const raw = readFileSync(join(EV, f))
  manifest.files[f] = { bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex').slice(0, 16) }
}

// extract RESULT lines from known scripts outputs if evidence JSONs carry them
const read = (f) => {
  try { return JSON.parse(readFileSync(join(EV, f), 'utf8')) }
  catch { return null }
}
const phaseS = read('phase-s-aw-health.json')
const bench = read('bench-record.json')
const hostgate = read('bench-promote-active-hostgate.json')
const reconcileBefore = read('reconcile-before.json')
const reconcileAfter = read('reconcile-after.json')
const rtu = read('rtu-after.json')
const expStats = read('phase-s-experience-stats.json')

const lines = []
lines.push(`# TSA4 live acceptance round report (v${VERSION})`)
lines.push('')
lines.push(`- Generated: ${manifest.generatedAt}`)
lines.push(`- Evidence dir: ${manifest.evidenceDir} (${files.length} JSON files)`)
lines.push(`- Build: v${VERSION} (origin/main a18c7576) on persisted home D:/tmp/aw-liv2-1119/home`)
lines.push('')
lines.push('## L1 stack & bridges')
lines.push(`- AW version: ${phaseS?.version ?? '?'}; experience-stats rows: ${expStats?.total ?? '?'}; anon read: see phase-s-experience-anon.json`)
lines.push(`- Bench run recorded: ${bench?.status === 200 ? 'yes' : 'no'}; host-provenance gate: ${JSON.stringify(hostgate?.activeFromShadowWithClientRun?.body?.reasons ?? hostgate ?? 'not-run')}`)
lines.push(`- Write-attempt ledger before/after restart: ${reconcileBefore?.countsByOutcome ? JSON.stringify(reconcileBefore.countsByOutcome) : 'n/a'} → ${reconcileAfter?.countsByOutcome ? JSON.stringify(reconcileAfter.countsByOutcome) : 'n/a'} (must be identical; no auto-resend)`)
lines.push(`- RTU probe after-state: ${rtu ? JSON.stringify(rtu).slice(0, 200) : 'not-run'}`)
lines.push('')
lines.push('## Capability answers')
lines.push('- 产线数采数控: see c1/c2/c3 evidence + smoke readback (this report links files, does not re-judge them)')
lines.push('- Project 编排: see dispatch-result.json / projects-watch.json / per-item terminal evidence')
lines.push('- Channel 内部/间通讯: see xch-*.json')
lines.push('- 经验记忆管理: see c4-*.json / phase-s-experience-*.json')
lines.push('')
lines.push('## Defect regression table')
lines.push('| Defect | Last known | This round | Fixed? |')
lines.push('| --- | --- | --- | --- |')
lines.push('| DEF-20261120-RTU-POOL-PENDING | silent offline | see rtu-*.json | from evidence |')
lines.push('| plan-card visibility gap | pending card invisible | see projects-watch.json planProgress.pendingApprovalId | from evidence |')
lines.push('| artifact resubmission gap | blocked legacy item | new-item route exercised (dispatch-result.json) | route OK, legacy items stay blocked |')
lines.push('')
lines.push('> 裁决口径:每条结论引用本轮证据文件;NOT_RUN/PARTIAL 如实标注,不复制历史基线。')

writeFileSync(join(EV, 'REPORT.md'), lines.join('\n'))
writeFileSync(join(EV, 'manifest.json'), JSON.stringify(manifest, null, 1))
console.log(`REPORT written: ${files.length} evidence files digested`)
