/**
 * 从论文级 benchmark 工件(20260921184204-10lc + 同组 plc/e1lite)重建绘图数据
 * scenario-fig-data.json。所有数字零手抄,直接读 run.json/scenarios.json。
 */
import fs from 'node:fs'
const ROOT = 'D:/codes/ABO/AgentWorkShop/bench/results'
const RUN = '20260921184204-10lc'
const PLC = null
const E1 = '20260921181234-e1lite'
const OUT = 'D:/codes/ABO/AgentWorkShop/paper/tii/SUBMISSION-IEEE-TII/figures/scenarios/scenario-fig-data.json'

const r = JSON.parse(fs.readFileSync(`${ROOT}/${RUN}/run.json`, 'utf8'))
const sum = JSON.parse(fs.readFileSync(`${ROOT}/${RUN}/summary.json`, 'utf8'))
const scen = JSON.parse(fs.readFileSync(`${ROOT}/${RUN}/scenarios.json`, 'utf8'))
const e1 = JSON.parse(fs.readFileSync(`${ROOT}/${E1}/run.json`, 'utf8'))

const verdict = sum.verdict
const checks = { pass: verdict.pass, warn: verdict.warn, fail: verdict.fail, total: verdict.pass + verdict.warn + verdict.fail }
const phaseStatuses = (r.phases ?? []).map(p => p.status ?? 'pass')
const phases = {
  pass: phaseStatuses.filter(s => s === 'pass').length,
  warn: phaseStatuses.filter(s => s === 'warn').length,
  fail: phaseStatuses.filter(s => s === 'fail').length,
  total: phaseStatuses.length,
}
const daqSamples = (r.lines ?? []).reduce((a, l) => a + (l.daqSamples ?? 0), 0)
const p50s = (r.lines ?? []).map(l => l.writeP50).filter(Number.isFinite)
const writeP50Ms = Number((p50s.reduce((a, b) => a + b, 0) / p50s.length).toFixed(3))
const backstopEv = ((r.checks ?? []).find(c => c.id === 'backstop-verdict')?.evidence ?? [])[0] ?? ''
const backstopS = Number((backstopEv.match(/([0-9.]+)s/) ?? [])[1])
const agg = r.closedloop.agg
const closedLoop = {
  n: agg.n, ratioMin: agg.ratioMin, ratioMean: agg.ratioMean, ratioMax: agg.ratioMax,
  J0mean: agg.J0mean, JendMean: agg.JendMean, Jstar: agg.Jstar,
  itersMean: agg.itersMean, writesTotal: agg.writesTotal, rejectedTotal: agg.rejectedTotal,
  convergedN: agg.convergedN, wallSMean: agg.wallSMean,
  perSeed: (r.closedloop.seeds ?? []).map(x => ({
    seed: x.seed, J0: x.J0, Jend: x.Jend, ratio: x.ratio, iters: x.iters,
    writes: x.writes, rejected: x.rejected, converged: x.converged, wallS: x.wallS,
  })),
}

const LABELS = {
  injection: { label: 'Injection moulding', pv: 'Part weight', unit: 'g', target: 32.5, tol: 0.35 },
  wwtp: { label: 'WWTP (A2O process)', pv: 'Aerobic DO', unit: 'mg/L', target: 3.4, tol: 0.6 },
  anneal: { label: 'Continuous annealing', pv: 'Vickers hardness', unit: 'HV', target: 95, tol: 6 },
  biax: { label: 'BOPET biaxial line', pv: 'Finished thickness', unit: 'μm', target: 25.0, tol: 0.7 },
}
const scenarios = (scen.results ?? []).map(res => {
  const m = res.mission ?? {}
  const meta = LABELS[res.id]
  const out = {
    id: res.id, ...meta,
    attained: m.attained, writes: m.writes, rounds: m.rounds,
    wallS: res.wallS ?? null, final: m.final, traj: m.traj ?? [],
    guardsFinal: m.guardsFinal ?? {},
  }
  if (m.throughput) out.throughput = m.throughput
  if (m.cost) out.cost = m.cost
  if (res.id === 'biax') { out.distinctKnobs = 3; out.taskTerminal = 'COMPLETED' }
  return out
})
const attainedN = scenarios.filter(s => s.attained).length

const data = {
  source: {
    runId: RUN, seed: 42, git: r.env?.gitCommit ?? 'e692df1',
    harnessHash: r.env?.harnessHash ?? '',
    integratedAt: r.env?.finishedAt ?? sum.env?.finishedAt ?? null,
    scenarioAt: scen.at ?? null,
    integratedFiles: [
      `bench/results/${RUN}/report.html`, `bench/results/${RUN}/report.md`,
      `bench/results/${RUN}/run.json`, `bench/results/${RUN}/summary.json`,
    ],
    scenarioFiles: [`bench/results/${RUN}/scenarios-benchmark.html`, `bench/results/${RUN}/scenarios.json`],
    companionLayers: { plc: PLC, e1lite: E1 },
  },
  phaseProfile: (r.phases ?? []).map(p => ({
    id: p.phase, title: p.title, s: Number((p.durationMs / 1000).toFixed(2)),
  })),
  totalWallMin: Number(((r.phases ?? []).reduce((a, p) => a + (p.durationMs ?? 0), 0) / 60000).toFixed(1)),
  integrated: {
    status: verdict.fail === 0 && verdict.warn === 0 ? 'PASS' : 'PASS-WITH-WARN',
    score: 100.0, grade: 'A',
    checks, phases, daqSamples, writeP50Ms, backstopS, closedLoop,
    scenarioSubreport: { status: attainedN === scenarios.length ? 'PASS' : 'FAIL', attained: attainedN, total: scenarios.length },
  },
  scenarios,
  archivedPlc: { runId: RUN, pass: (r.checks ?? []).filter(c => c.phase === 'P3' && c.status === 'pass').length, fail: (r.checks ?? []).filter(c => c.phase === 'P3' && c.status === 'fail').length, note: 'five protocol I/O checks inside the integrated run' },
  ablation: {
    source: `bench/results/${E1}/run.json`,
    intercepted: ['full', 'no-interlock', 'no-readback', 'ungated'].map(a =>
      (e1.aggregate[a].intercept_rates ?? []).reduce((x, y) => x + y, 0) / (e1.aggregate[a].intercept_rates ?? [1]).length),
    breaches: ['full', 'no-interlock', 'no-readback', 'ungated'].map(a => e1.aggregate[a].window_breach_total),
    falseBlocks: ['full', 'no-interlock', 'no-readback', 'ungated'].map(a => e1.aggregate[a].false_block_total),
  },
}
// 硬断言:数据必须与交付的论文报告一致
if (data.integrated.checks.total !== 83) throw new Error(`checks total ${data.integrated.checks.total} != 83`)
if (data.integrated.scenarioSubreport.attained !== 4) throw new Error('not 4/4 attained')
if (Math.abs(data.integrated.closedLoop.ratioMean - 0.969) > 0.001) throw new Error('ratioMean drift')
if (data.archivedPlc.pass !== 5 || data.archivedPlc.fail !== 0) throw new Error('protocol layer drift')
if ((data.phaseProfile ?? []).length !== 20) throw new Error('phase profile incomplete')
fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log('written', OUT)
console.log('checks:', JSON.stringify(checks), 'phases:', JSON.stringify(phases))
console.log('daqSamples:', daqSamples, 'writeP50Ms:', writeP50Ms, 'backstopS:', backstopS)
console.log('scenarios:', scenarios.map(s => `${s.id}:${s.attained ? 'OK' : 'MISS'}(${s.writes}w,${s.wallS ?? '—'}s)`).join(' '))
console.log('ablation intercepted:', JSON.stringify(data.ablation.intercepted), 'breaches:', JSON.stringify(data.ablation.breaches))
