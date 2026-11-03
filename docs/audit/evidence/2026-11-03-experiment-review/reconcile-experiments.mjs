/**
 * 跨 run 对账 E1/E2/E4 论文级数字,输出 JSON+MD 证据。
 * 不产生新判定,只从产物重算并断言与 PAPER-READY-RESULTS.md 一致。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const REPO = 'D:/codes/ABO/AgentWorkShop'
const OUT = `${REPO}/docs/audit/evidence/2026-11-03-experiment-review`
mkdirSync(OUT, { recursive: true })

function csv(path) {
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  const head = lines[0].split(',')
  return lines.slice(1).map((l) => {
    const cells = l.split(',')
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']))
  })
}

const problems = []
function assert(name, cond, detail) {
  if (!cond) problems.push(`${name}: ${detail}`)
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}

// ---------- E1 ----------
const probes = [
  { rid: '20261101121221-scenario-probes', path: `${REPO}/bench/results/20261101121221-scenario-probes/scenario-protocol-probes.csv` },
  { rid: '20261101121700-scenario-probes', path: `${REPO}/bench/results/20261101121700-scenario-probes/scenario-protocol-probes.csv` },
]
const e1 = {}
for (const p of probes) {
  for (const r of csv(p.path)) {
    const s = e1[r.scene] ?? (e1[r.scene] = { accepted: 0, rejected: 0, readback: 0, restore: 0, protocols: new Set(), sources: new Set() })
    s.protocols.add(r.protocol)
    s.sources.add(p.rid)
    if (r.probeClass === 'legal' || r.probeClass === 'boundary') {
      if (r.got === 'accept') s.accepted++
    }
    if (r.probeClass === 'structural') { if (r.got === 'reject') s.rejected++ }
    if (r.probeClass === 'restore') { if (r.got === 'accept') s.restore++ }
    if (r.readback !== '' && r.readback !== 'n/a') s.readback++
  }
}
const totals = Object.values(e1).reduce((a, s) => ({ accepted: a.accepted + s.accepted, rejected: a.rejected + s.rejected, readback: a.readback + s.readback, restore: a.restore + s.restore }), { accepted: 0, rejected: 0, readback: 0, restore: 0 })
assert('E1 合法+边界受理 244/244', totals.accepted === 244, `accepted=${totals.accepted}`)
assert('E1 结构越界拒绝 243/243', totals.rejected === 243, `rejected=${totals.rejected}`)
assert('E1 回读可用 236/236', totals.readback === 236, `readback=${totals.readback}`)
assert('E1 五场景覆盖', Object.keys(e1).sort().join(',') === 'anneal,biax,cast-film-physics,injection,wwtp', Object.keys(e1).join(','))

// film-line from pipeline matrix
const matrix = csv(`${REPO}/bench/reports-archive/2026-11-01-perfect/protocol-matrix.csv`)
const film = matrix.filter(r => r.scene === 'film-line')
const filmProbes = film.reduce((a, r) => a + Number(String(r.probesRejected || 0)), 0)
const filmTotal = film.reduce((a, r) => a + Number(String(r.probesTotal || 0)), 0)
assert('E1 film-line 9/9 拒绝', filmProbes === 9 && filmTotal === 9, `${filmProbes}/${filmTotal}`)

// ---------- E2 ----------
// use ESM fs
import { readdirSync } from 'node:fs'
const dir = `${REPO}/bench/reports-archive/2026-11-01-perfect`
const c0Files = readdirSync(dir).filter(f => f.startsWith('c0-') && f.endsWith('.csv'))
const c1Files = readdirSync(dir).filter(f => f.startsWith('c1-') && f.endsWith('.csv'))
function countAttained(files) {
  let total = 0, attained = 0
  const perScene = {}
  for (const f of files) {
    for (const r of csv(`${dir}/${f}`)) {
      total++
      const v = String(r.attained ?? r.inBand ?? '').toLowerCase()
      const ok = v === 'true' || v === '1' || v === 'yes'
      if (ok) attained++
      const s = r.scene ?? r.scenario ?? '?'
      perScene[s] = perScene[s] ?? { total: 0, attained: 0 }
      perScene[s].total++
      if (ok) perScene[s].attained++
    }
  }
  return { total, attained, perScene }
}
const c0 = countAttained(c0Files)
const c1 = countAttained(c1Files)
assert('E2 C0 0/15 未达标', c0.total === 15 && c0.attained === 0, `${c0.attained}/${c0.total}`)
assert('E2 C1 15/15 达标', c1.total === 15 && c1.attained === 15, `${c1.attained}/${c1.total}`)

// ---------- E4 ----------
const e4 = csv(`${dir}/e4-defense-layers.csv`)
const e4Rows = e4.map(r => ({ layer: r.layer && r.layer !== '—' ? r.layer : 'baseline', expect: r.expect, got: r.got, status: r.status, code: r.code }))
const e4Mismatch = e4Rows.filter(r => r.got !== r.expect)
const e4Layers = [...new Set(e4Rows.map(r => r.layer))]
assert('E4 P 态五层无错配', e4Mismatch.length === 0, `rows=${e4Rows.length} mismatch=${e4Mismatch.length}`)
assert('E4 覆盖 L2-L6 + 基线', ['L2','L3','L4','L5','L6'].every(l => e4Layers.includes(l)) && e4Layers.includes('baseline'), e4Layers.join(','))

// E4 四臂(B 态 e1-lite.csv)
const armsRaw = csv(`${dir}/e1lite/e1-lite.csv`)
const arms = {}
for (const r of armsRaw) {
  const a = arms[r.arm] ?? (arms[r.arm] = { attack: 0, attackRejected: 0, attackExecuted: 0, legal: 0, legalOk: 0, boundaryAccept: 0, boundaryReject: 0 })
  if (r.case === 'attack') { a.attack++; if (r.verdict === 'rejected') a.attackRejected++; if (r.verdict === 'EXECUTED') a.attackExecuted++ }
  if (r.case === 'legit') { a.legal++; if (r.verdict === 'ok') a.legalOk++ }
  if (r.case === 'boundary') { if (String(r.verdict).startsWith('accept')) a.boundaryAccept++; if (String(r.verdict).startsWith('reject')) a.boundaryReject++ }
}
assert('E4 full 18/18 拒绝', arms.full?.attackRejected === 18 && arms.full?.attack === 18, JSON.stringify(arms.full))
assert('E4 no-readback 18/18 拒绝', arms['no-readback']?.attackRejected === 18, JSON.stringify(arms['no-readback']))
assert('E4 no-interlock 12/18 拒绝 + 6 执行', arms['no-interlock']?.attackRejected === 12 && arms['no-interlock']?.attackExecuted === 6, JSON.stringify(arms['no-interlock']))
assert('E4 ungated 12/18 拒绝 + 6 执行', arms.ungated?.attackRejected === 12 && arms.ungated?.attackExecuted === 6, JSON.stringify(arms.ungated))
assert('E4 误拦 0/9(每臂合法 9/9)', Object.values(arms).every(a => a.legal === 9 && a.legalOk === 9), JSON.stringify(Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, `${v.legalOk}/${v.legal}`]))))

const report = {
  at: new Date().toISOString(),
  e1: { scenes: Object.fromEntries(Object.entries(e1).map(([k, v]) => [k, { accepted: v.accepted, rejected: v.rejected, readback: v.readback, restore: v.restore, protocols: [...v.protocols].sort(), sources: [...v.sources] }])), totals, filmLine: { rejected: filmProbes, total: filmTotal } },
  e2: { c0, c1 },
  e4: { rows: e4Rows.length, mismatch: e4Mismatch, layers: e4Layers, arms },
  problems,
}
writeFileSync(`${OUT}/reconciliation.json`, JSON.stringify(report, null, 2))
const md = [
  '# 实验账本跨 run 对账(2026-11-03)',
  '',
  `> 从产物重算,不产生新判定。问题数:${problems.length}`,
  '',
  '## E1 场景×协议准入',
  '',
  '| 场景 | 合法+边界受理 | 结构越界拒绝 | 回读可用 | 恢复写 | 协议 | 来源 run |',
  '|---|---|---|---|---|---|---|',
  ...Object.entries(e1).map(([k, v]) => `| ${k} | ${v.accepted} | ${v.rejected} | ${v.readback} | ${v.restore} | ${[...v.protocols].sort().join('/')} | ${[...v.sources].join(',')} |`),
  `| **合计** | **${totals.accepted}** | **${totals.rejected}** | **${totals.readback}** | ${totals.restore} | 5 类 | — |`,
  '',
  `film-line(集成流水线 P8):探针 ${filmProbes}/${filmTotal} 拒绝。`,
  '',
  '## E2 优化对照(5 seed × 3 场景)',
  '',
  `- C0 不写:${c0.attained}/${c0.total} 达标(要求 0)`,
  `- C1 脚本策略:${c1.attained}/${c1.total} 达标(要求 15/15)`,
  '',
  '## E4 防御纵深(P 态五层)',
  '',
  `覆盖层:${e4Layers.join(' / ')};共 ${e4Rows.length} 行,expect/got 错配 ${e4Mismatch.length}。`,
  '',
  e4Mismatch.length ? `\`\`\`json\n${JSON.stringify(e4Mismatch, null, 2)}\n\`\`\`` : '五层与基线均按预期(基线合法写 accept;L2–L6 各自 reject)。',
  '',
  '## E4 四臂(B 态 e1-lite)',
  '',
  '| 臂 | 攻击拒绝 | 攻击执行 | 合法通过 |',
  '|---|---|---|---|',
  ...Object.entries(arms).map(([k, a]) => `| ${k} | ${a.attackRejected}/${a.attack} | ${a.attackExecuted} | ${a.legalOk}/${a.legal} |`),
  '',
  problems.length ? `## 问题\n\n${problems.map(p => `- ${p}`).join('\n')}` : '## 判定\n\n全部断言通过:产物与 PAPER-READY-RESULTS.md 的论文级数字一致。',
].join('\n')
writeFileSync(`${OUT}/reconciliation.md`, md)
console.log(`\nproblems=${problems.length}`)
if (problems.length) process.exitCode = 1
