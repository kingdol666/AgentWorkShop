/**
 * bench/lib/report-template.mjs —— AW-IndustrialBench 英文报告模板（MD + HTML，论文可发表级）。
 *
 * 设计方向「控制室检验记录单」：纸白底 + 油墨色 + 单一信号绿 accent + 钢印式 verdict 章，
 * 发丝线表格与等宽表格数字；与项目控制室设计宪法同源但降饱和为印刷级油墨色。
 * 反 AI slop：无渐变、无 emoji 图标、无圆角卡片+左彩条、无暗底霓虹；零 CDN，断网双击可开，
 * 自带 @media print 样式可直接作为论文附图输出。设计推导见同目录 direction-notes.md。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : '—')
const grade = (score) => (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D')

/** 执行产物档案（AgentTeam 轨迹 / 调试日志 / 机器可读结果）——入档清单随报告发布 */
export function collectArtifacts(outDir, names) {
  const out = []
  for (const n of names) {
    try {
      const st = statSync(join(outDir, n))
      out.push({ name: n, bytes: st.size })
    } catch { /* 未产生的产物(如未跑 --agent)不列 */ }
  }
  return out
}

const HUMANIZE = {
  'agentteam-mission.log': 'AgentTeam optimization mission — full task-board trajectory',
  'agentteam-biax.log': 'AgentTeam biax multi-node mission — full trajectory',
  'metrics.csv': 'Quantitative metrics registry (flat CSV)',
  'run.json': 'Full machine-readable results (checks, phases, evidence, KPIs)',
  'summary.json': 'Verdict + KPI + per-line summary (compare/aggregate input)',
}

// ─────────────────────────── HTML ───────────────────────────

export function renderBenchmarkHtml({ env, phases, checks, kpis, metrics, closedloop, charts, artifacts }) {
  const byPhase = new Map()
  for (const c of checks) if (!byPhase.has(c.phase)) byPhase.set(c.phase, [])
  for (const c of checks) byPhase.get(c.phase).push(c)

  const PHASE_WEIGHTS = { P0: 1, P1: 1, P2: 2, P3: 3, P4: 3, P4f: 3, P4m: 3, P4b: 2, P4c: 2, P4d: 1, P4e: 2, P6: 3, P7: 1, P8: 3, P8b: 3, P10: 3, P9: 1 }
  const PHASE_TITLES = {
    P0: 'Bootstrap · simulator & platform', P1: 'Plant model + offline optimum W*',
    P2: 'Multi-protocol line provisioning', P3: 'DAQ · governed write · F5 interlock',
    P4: 'Agent-tool closed loop (3-cycle convergence)',
    P4f: 'Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)',
    P4m: 'AgentTeam optimization mission (task board → governed writes → attainment)',
    P4b: 'Rollback & optimization records', P4c: 'HITL approval gate', P4d: 'Audit / ledger read surfaces',
    P4e: 'Recipe lifecycle', P6: 'Closed-loop optimization benchmark (multi-seed)',
    P7: 'Multimodal acquisition (vector/image)', P8: 'Cross-scenario portability',
    P8b: 'System backstop drill (bounded autonomy)', P9: 'Platform subsystems (team / memory / registry)',
    P10: 'Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)',
  }
  const rows = [...byPhase.keys()].sort().map((ph) => {
    const list = byPhase.get(ph)
    const p = list.filter((c) => c.status === 'pass').length
    const w = list.filter((c) => c.status === 'warn').length
    const f = list.filter((c) => c.status === 'fail').length
    const s = list.filter((c) => c.status === 'skip').length
    const scored = p + w + f
    return { ph, title: PHASE_TITLES[ph] ?? '', p, w, f, s, score: scored ? ((p + 0.5 * w) / scored) * 100 : null, wt: PHASE_WEIGHTS[ph] ?? 1 }
  })
  let wSum = 0, sSum = 0
  for (const r of rows) if (r.score != null) { wSum += r.wt; sSum += r.wt * r.score }
  const overall = wSum ? sSum / wSum : 0
  const anyFail = checks.some((c) => c.status === 'fail') || phases.some((p) => p.status === 'fail')
  const nPass = checks.filter((c) => c.status === 'pass').length
  const nWarn = checks.filter((c) => c.status === 'warn').length
  const nFail = checks.filter((c) => c.status === 'fail').length
  const nSkip = checks.length - nPass - nWarn - nFail
  const verdict = anyFail ? 'FAIL' : checks.length === 0 ? 'FAIL' : 'PASS'
  const effGrade = anyFail ? 'F' : grade(overall)
  const stampTone = verdict === 'PASS' ? 'ok' : 'bad'

  const kpiGrid = (kpis ?? []).map((k) => `
      <div class="kpi">
        <div class="kpi-v">${esc(k.value)}<span>${esc(k.unit ?? '')}</span></div>
        <div class="kpi-l">${esc(k.label)}</div>
        ${k.note ? `<div class="kpi-n">${esc(k.note)}</div>` : ''}
      </div>`).join('')

  const phaseTable = rows.map((r) => `
        <tr class="${r.f ? 'row-bad' : ''}">
          <td class="mono">${esc(r.ph)}</td><td>${esc(r.title)}</td>
          <td class="num ok">${r.p}</td><td class="num warn">${r.w}</td>
          <td class="num bad">${r.f}</td><td class="num dim">${r.s}</td>
          <td class="num strong">${r.score == null ? '—' : r.score.toFixed(1)}</td>
          <td class="num dim">${r.wt}</td>
        </tr>`).join('')

  const checkBlock = [...byPhase.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((ph) => {
    const list = byPhase.get(ph)
    const bad = list.some((c) => c.status === 'fail')
    const items = list.map((c) => {
      const mark = c.status === 'pass' ? '✔' : c.status === 'warn' ? '▲' : c.status === 'skip' ? '↓' : '✘'
      const tone = c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'warn' : c.status === 'skip' ? 'dim' : 'bad'
      const ev = (c.evidence ?? []).filter(Boolean).slice(0, 4).map((e) => `<li>${esc(String(e).replace(/\n/g, ' ').slice(0, 240))}</li>`).join('')
      return `<li class="chk"><span class="mark ${tone}">${mark}</span> <span class="chk-id mono">${esc(c.id)}</span> <span class="chk-t">${esc(c.title)}</span>${ev ? `<ul class="ev">${ev}</ul>` : ''}</li>`
    }).join('')
    return `
      <details ${bad ? 'open' : ''}>
        <summary><span class="mono">${esc(ph)}</span> — ${esc(PHASE_TITLES[ph] ?? '')}
          <span class="sum-n">${list.filter((c) => c.status === 'pass').length}/${list.length} pass</span></summary>
        <ul class="chks">${items}</ul>
      </details>`
  }).join('')

  const clTable = closedloop?.agg
    ? `
      <h3>Closed-loop optimization · per-seed</h3>
      <table class="grid">
        <thead><tr><th>Seed</th><th class="num">J₀</th><th class="num">J<sub>end</sub></th><th class="num">J*</th><th class="num">J/J* %</th><th class="num">Iters</th><th class="num">Governed writes</th><th class="num">Rejected</th><th>Converged</th></tr></thead>
        <tbody>
        ${(closedloop.seeds ?? []).map((s) => `
          <tr><td class="mono">${s.seed}</td><td class="num">${num(s.J0)}</td><td class="num">${num(s.Jend)}</td>
          <td class="num">${num(s.Jstar)}</td><td class="num strong">${s.ratio != null ? (s.ratio * 100).toFixed(1) : '—'}</td>
          <td class="num">${s.iters ?? s.stats?.iters ?? '—'}</td><td class="num">${s.writes ?? s.stats?.writes ?? '—'}</td>
          <td class="num">${s.rejected ?? s.stats?.rejected ?? '—'}</td>
          <td class="${(s.converged ?? s.stats?.converged) ? 'ok' : 'warn'}">${(s.converged ?? s.stats?.converged) ? 'yes' : 'no'}</td></tr>`).join('')}
        </tbody>
      </table>`
    : ''

  const trajRows = (artifacts ?? []).map((a) => `
          <tr><td class="mono">${esc(a.name)}</td>
          <td class="num">${(a.bytes / 1024).toFixed(1)} KB</td>
          <td class="dim">${esc(HUMANIZE[a.name] ?? 'Execution / trajectory log (verbatim archive)')}</td></tr>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AW-IndustrialBench Report · ${esc(env.runId)}</title>
<style>
  :root{
    --paper:#fbfaf7; --ink:#212426; --dim:#6b6f72; --hair:#d9d5cb; --hair2:#e7e3da;
    --ok:#0a7d54; --warn:#8a5a00; --bad:#a03030; --cyan:#1f6f8b; --panel:#f4f2ec;
    --serif:"Source Serif 4","Noto Serif",Georgia,"Times New Roman",serif;
    --sans:-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,"Cascadia Mono","JetBrains Mono",Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.62 var(--sans);
       text-wrap:pretty;-webkit-font-smoothing:antialiased}
  .sheet{max-width:1060px;margin:0 auto;padding:44px 40px 64px}
  a{color:var(--cyan);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--cyan) 35%,transparent)}

  /* ── masthead ── */
  .mast{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
        border-bottom:3px double var(--ink);padding-bottom:18px}
  .brand{font:600 13px/1 var(--sans);letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}
  .brand b{color:var(--ink)}
  h1{font:600 34px/1.15 var(--serif);margin:10px 0 4px;letter-spacing:-.01em}
  .sub{color:var(--dim);font-size:13.5px}
  .sub .mono{font-size:12.5px}
  .stamp{flex:none;transform:rotate(-4deg);border:3px double var(--ink);outline:1px solid var(--ink);outline-offset:3px;
         padding:10px 18px;text-align:center;font:700 20px/1.2 var(--sans);letter-spacing:.3em;text-transform:uppercase}
  .stamp small{display:block;font:500 9.5px/1.6 var(--sans);letter-spacing:.18em;color:var(--dim)}
  .stamp.ok{color:var(--ok);border-color:var(--ok);outline-color:var(--ok)}
  .stamp.ok small{color:var(--ok)}
  .stamp.bad{color:var(--bad);border-color:var(--bad);outline-color:var(--bad)}
  .stamp.bad small{color:var(--bad)}

  /* ── verdict strip ── */
  .strip{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--hair);
         border-top:none;background:var(--panel);margin-top:0}
  .cell{padding:14px 18px;border-left:1px solid var(--hair)}
  .cell:first-child{border-left:none}
  .cell .cl{font:600 10.5px/1.4 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .cell .cv{font:600 26px/1.2 var(--serif);font-variant-numeric:tabular-nums}
  .cell .cv small{font-size:14px;color:var(--dim);font-weight:400}
  .gate{margin:14px 0 0;padding:10px 16px;border-left:3px solid var(--ok);background:var(--panel);
        font-size:13.5px;color:var(--ink)}
  .gate.bad{border-left-color:var(--bad)}

  h2{font:600 21px/1.3 var(--serif);margin:44px 0 4px;letter-spacing:-.005em}
  h2 .no{color:var(--dim);font-weight:400;margin-right:10px;font-variant-numeric:tabular-nums}
  .lede{color:var(--dim);font-size:13.5px;margin:0 0 16px}

  /* ── KPI grid ── */
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--hair);
        border:1px solid var(--hair)}
  .kpi{background:var(--paper);padding:12px 14px}
  .kpi-v{font:600 21px/1.15 var(--serif);font-variant-numeric:tabular-nums}
  .kpi-v span{font-size:12px;color:var(--dim);margin-left:3px;font-weight:400}
  .kpi-l{font:600 11px/1.4 var(--sans);letter-spacing:.06em;text-transform:uppercase;margin-top:4px}
  .kpi-n{font-size:11.5px;color:var(--dim);margin-top:2px}

  /* ── tables ── */
  table.grid{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
  table.grid th{font:600 10.5px/1.4 var(--sans);letter-spacing:.12em;text-transform:uppercase;
                color:var(--dim);text-align:left;padding:8px 10px;border-bottom:2px solid var(--ink)}
  table.grid td{padding:8px 10px;border-bottom:1px solid var(--hair2);vertical-align:top}
  table.grid tr:last-child td{border-bottom:1px solid var(--hair)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  th.num{text-align:right}
  .strong{font-weight:600}
  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .dim{color:var(--dim)}
  .mono{font-family:var(--mono);font-size:.92em}
  tr.row-bad td{background:color-mix(in srgb,var(--bad) 6%,transparent)}
  tfoot td{border-bottom:none;border-top:2px solid var(--ink);font-weight:600}

  /* ── charts ── */
  .charts{display:grid;grid-template-columns:1fr 1fr;gap:22px}
  .chart{border:1px solid var(--hair);padding:14px 16px;background:#fff}
  .chart h3{font:600 12px/1.4 var(--sans);letter-spacing:.08em;text-transform:uppercase;
            margin:0 0 10px;color:var(--ink)}
  .chart svg{width:100%;height:auto;display:block}
  .chart .bl{font:11px var(--sans);fill:var(--ink)}
  .chart .bv{font:11px var(--mono);fill:var(--dim)}

  /* ── check details ── */
  details{border:1px solid var(--hair);border-top:none}
  details:first-of-type{border-top:1px solid var(--hair)}
  summary{cursor:pointer;padding:11px 16px;font:600 13.5px/1.5 var(--sans);list-style:none;
          display:flex;align-items:baseline;gap:10px;background:var(--paper)}
  summary::-webkit-details-marker{display:none}
  summary::after{content:"+";margin-left:auto;color:var(--dim);font-weight:400}
  details[open] summary::after{content:"–"}
  details[open]{background:#fff}
  .sum-n{margin-left:auto;font:400 12px var(--mono);color:var(--dim)}
  summary .mono{color:var(--cyan)}
  .chks{list-style:none;margin:0;padding:4px 16px 14px}
  .chk{padding:7px 0;border-bottom:1px solid var(--hair2)}
  .chk:last-child{border-bottom:none}
  .mark{font-weight:700}
  .chk-id{color:var(--dim)}
  .ev{margin:6px 0 0;padding-left:26px;font:12px/1.55 var(--mono);color:var(--dim)}
  .ev li{margin:2px 0;list-style:"–  "}

  /* ── artifacts / fingerprint ── */
  .fingerprint{border:1px solid var(--hair);background:var(--panel);padding:16px 18px;font-size:13px}
  .fingerprint .row{display:flex;gap:14px;padding:3px 0}
  .fingerprint .fk{flex:none;width:170px;font:600 10.5px/1.8 var(--sans);letter-spacing:.1em;
                   text-transform:uppercase;color:var(--dim)}
  .fingerprint .fv{font-family:var(--mono);font-size:12.5px;word-break:break-all}
  .repro{margin-top:10px;padding:10px 14px;background:var(--ink);color:#f3f1ea;
         font:12.5px/1.6 var(--mono);overflow-x:auto;white-space:pre}

  .foot{margin-top:48px;border-top:3px double var(--ink);padding-top:12px;
        display:flex;justify-content:space-between;gap:20px;color:var(--dim);font-size:12px}

  @media (max-width:900px){
    .kpis{grid-template-columns:repeat(3,1fr)}
    .charts{grid-template-columns:1fr}
    .strip{grid-template-columns:repeat(2,1fr)}
    .cell{border-top:1px solid var(--hair)}
  }
  @media print{
    body{font-size:11.5px}
    .sheet{padding:0;max-width:none}
    details{border-color:#bbb} .stamp{transform:rotate(-3deg)}
    .charts{grid-template-columns:1fr 1fr}
    .repro{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    h2{break-after:avoid} .chart,table.grid{break-inside:avoid}
  }
</style>
</head>
<body>
<div class="sheet">

  <div class="mast">
    <div>
      <div class="brand"><b>AW-IndustrialBench</b> · Governed Industrial Agent Platform</div>
      <h1>Integrated Pipeline Benchmark Report</h1>
      <div class="sub">run <span class="mono">${esc(env.runId)}</span> · seed <span class="mono">${esc(String(env.seed))}</span> ·
        preset <span class="mono">${esc(env.preset)}</span> · ${esc(env.base)} · started ${esc(String(env.startedAt ?? '').slice(0, 19)).replace('T', ' ')}</div>
    </div>
    <div class="stamp ${stampTone}">${esc(verdict)}<small>score ${overall.toFixed(1)} · grade ${effGrade}</small></div>
  </div>

  <div class="strip">
    <div class="cell"><div class="cl">Checks</div><div class="cv">${nPass}<small> / ${checks.length} pass</small></div></div>
    <div class="cell"><div class="cl">Warnings</div><div class="cv">${nWarn}</div></div>
    <div class="cell"><div class="cl">Failures</div><div class="cv ${nFail ? '' : 'ok'}">${nFail}</div></div>
    <div class="cell"><div class="cl">Skipped (honest)</div><div class="cv dim">${nSkip}</div></div>
  </div>
  <div class="gate ${anyFail ? 'bad' : ''}">${anyFail
    ? 'Hard gate: at least one check or phase failed — the score above is informational only; the gate rules. Do not cite this run as passing.'
    : 'Hard gate: no failed checks, no failed phases. Every gate is green; skipped items are honest environmental skips and are excluded from scoring.'}</div>

  <h2><span class="no">01</span>Key indicators</h2>
  <p class="lede">Pooled results across all provisioned lines and protocols. Judge-class metrics are deterministic under a fixed seed.</p>
  <div class="kpis">${kpiGrid}</div>

  <h2><span class="no">02</span>Phase scorecard</h2>
  <p class="lede">Phase score = (pass + 0.5 × warn) / scored checks × 100; skips are excluded. Overall is the weighted mean; any failure trips the hard gate.</p>
  <table class="grid">
    <thead><tr><th>Phase</th><th>Title</th><th class="num">Pass</th><th class="num">Warn</th><th class="num">Fail</th><th class="num">Skip</th><th class="num">Score</th><th class="num">Weight</th></tr></thead>
    <tbody>${phaseTable}</tbody>
    <tfoot><tr><td colspan="6">Overall (weighted)</td><td class="num strong">${overall.toFixed(1)}</td><td class="num">${wSum}</td></tr></tfoot>
  </table>

  <h2><span class="no">03</span>Quantitative panels</h2>
  <p class="lede">Real-protocol transactions and closed-loop optimization outcomes. Bars use tabular figures; unit scale is absolute unless noted.</p>
  <div class="charts">${(charts ?? '').join ? charts.join('') : (charts ?? '')}</div>

${closedloop?.agg
  ? `  <h2><span class="no">04</span>Closed-loop optimization benchmark</h2>
  <p class="lede">Multi-seed governed closed-loop seeking on the cast-film digital twin, scored against the offline optimum W*. Write path is the governed agent tool surface; every write is ledgered.</p>
  ${clTable}`
  : ''}

  <h2><span class="no">${closedloop?.agg ? '05' : '04'}</span>Check details</h2>
  <p class="lede">Verbatim evidence per check, collapsed by default; failed phases are expanded. Evidence lines are quoted from the run without paraphrase.</p>
  ${checkBlock}

  <h2><span class="no">${closedloop?.agg ? '06' : '05'}</span>Execution artifacts (Agent-team trajectory archive)</h2>
  <p class="lede">Optimization missions and debug loops are archived verbatim beside this report — the AgentTeam decision trajectory is reproducible evidence, not a summary.</p>
  <table class="grid">
    <thead><tr><th>Artifact</th><th class="num">Size</th><th>Contents</th></tr></thead>
    <tbody>${trajRows}</tbody>
  </table>

  <h2><span class="no">${closedloop?.agg ? '07' : '06'}</span>Fingerprint &amp; reproduction</h2>
  <div class="fingerprint">
    <div class="row"><div class="fk">Harness hash</div><div class="fv">${esc(String(env.harnessHash ?? '').slice(0, 16))} (sha256 over ${esc(String(env.harnessFiles ?? '?'))} checker sources)</div></div>
    <div class="row"><div class="fk">Git commit</div><div class="fv">${esc(String(env.gitCommit ?? 'unknown'))}</div></div>
    <div class="row"><div class="fk">Runtime</div><div class="fv">${esc(String(env.node ?? ''))} · ${esc(String(env.platform ?? ''))}</div></div>
    <div class="row"><div class="fk">Platform / simulator</div><div class="fv">${esc(env.base)} · ${esc(env.simBase)}</div></div>
    <div class="row"><div class="fk">Tool harness</div><div class="fv">${esc(String(env.toolHarness ?? ''))} (deterministic, no LLM) · agent: ${esc(String(env.agentHarness ?? '(none)'))}</div></div>
    <div class="repro">${esc(env.reproCmd ?? '')}</div>
  </div>

  <div class="foot">
    <div>AW-IndustrialBench · integrated pipeline · every number in this sheet is machine-produced from the archived run.json</div>
    <div class="mono">${esc(env.runId)}</div>
  </div>
</div>
</body>
</html>`
}

// ─────────────────────────── Markdown ───────────────────────────

export function renderBenchmarkMd({ env, phases, checks, kpis, metrics, closedloop, artifacts }) {
  const byPhase = new Map()
  for (const c of checks) {
    if (!byPhase.has(c.phase)) byPhase.set(c.phase, [])
    byPhase.get(c.phase).push(c)
  }
  const PHASE_WEIGHTS = { P0: 1, P1: 1, P2: 2, P3: 3, P4: 3, P4f: 3, P4m: 3, P4b: 2, P4c: 2, P4d: 1, P4e: 2, P6: 3, P7: 1, P8: 3, P8b: 3, P10: 3, P9: 1 }
  const PHASE_TITLES = {
    P0: 'Bootstrap · simulator & platform', P1: 'Plant model + offline optimum W*',
    P2: 'Multi-protocol line provisioning', P3: 'DAQ · governed write · F5 interlock',
    P4: 'Agent-tool closed loop (3-cycle convergence)',
    P4f: 'Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)',
    P4m: 'AgentTeam optimization mission (task board → governed writes → attainment)',
    P4b: 'Rollback & optimization records', P4c: 'HITL approval gate', P4d: 'Audit / ledger read surfaces',
    P4e: 'Recipe lifecycle', P6: 'Closed-loop optimization benchmark (multi-seed)',
    P7: 'Multimodal acquisition (vector/image)', P8: 'Cross-scenario portability',
    P8b: 'System backstop drill (bounded autonomy)', P9: 'Platform subsystems (team / memory / registry)',
    P10: 'Biax (BOPET) full-line mission (probe → provision → multi-node AgentTeam closed loop)',
  }
  const rows = []
  let wSum = 0, sSum = 0
  for (const ph of [...byPhase.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const list = byPhase.get(ph)
    const p = list.filter((c) => c.status === 'pass').length
    const w = list.filter((c) => c.status === 'warn').length
    const f = list.filter((c) => c.status === 'fail').length
    const s = list.filter((c) => c.status === 'skip').length
    const scored = p + w + f
    const score = scored ? ((p + 0.5 * w) / scored) * 100 : null
    const wt = PHASE_WEIGHTS[ph] ?? 1
    if (score != null) { wSum += wt; sSum += wt * score }
    rows.push({ ph, title: PHASE_TITLES[ph] ?? '', p, w, f, s, score, wt })
  }
  const overall = wSum ? sSum / wSum : 0
  const anyFail = checks.some((c) => c.status === 'fail') || phases.some((p) => p.status === 'fail')
  const nPass = checks.filter((c) => c.status === 'pass').length
  const verdict = anyFail ? 'FAIL' : checks.length === 0 ? 'FAIL (no checks)' : 'PASS'
  const effGrade = anyFail ? 'F' : grade(overall)

  const L = []
  L.push(`# AW-IndustrialBench · Integrated Pipeline Report`)
  L.push('')
  L.push(`> **${verdict}** — score **${overall.toFixed(1)}**/100, grade **${effGrade}**. ${anyFail
    ? 'Hard gate tripped: at least one check/phase failed; the score is informational only.'
    : 'Hard gate green: no failed checks or phases; skips are honest environmental exclusions.'}`)
  L.push('')
  L.push('## Fingerprint')
  L.push('')
  L.push('| Field | Value |')
  L.push('|---|---|')
  L.push(`| Run ID | \`${env.runId}\` |`)
  L.push(`| Seed / preset | ${env.seed} / \`${env.preset}\` |`)
  L.push(`| Harness hash | \`${String(env.harnessHash ?? '').slice(0, 16)}\` (sha256 over ${env.harnessFiles} checker sources) |`)
  L.push(`| Git commit | \`${env.gitCommit}\` |`)
  L.push(`| Runtime | ${env.node} · ${env.platform} |`)
  L.push(`| Platform / simulator | ${env.base} · ${env.simBase} |`)
  L.push(`| Tool harness | ${env.toolHarness} (deterministic) · LLM agent: ${env.agentHarness ?? '(none)'} |`)
  L.push(`| Reproduce | \`${env.reproCmd}\` |`)
  L.push('')
  L.push('## Key indicators')
  L.push('')
  L.push('| KPI | Value | Note |')
  L.push('|---|---:|---|')
  for (const k of kpis) L.push(`| ${k.label} | ${k.value}${k.unit ? ' ' + k.unit : ''} | ${k.note ?? ''} |`)
  L.push('')
  L.push('## Phase scorecard (weighted)')
  L.push('')
  L.push('| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |')
  L.push('|---|---|---:|---:|---:|---:|---:|---:|')
  for (const r of rows) L.push(`| ${r.ph} | ${r.title} | ${r.p} | ${r.w} | ${r.f} | ${r.s} | ${r.score == null ? '—' : r.score.toFixed(1)} | ${r.wt} |`)
  L.push(`| **Overall** | | | | | | **${overall.toFixed(1)}** | ${wSum} |`)
  L.push('')
  if (closedloop?.agg) {
    L.push('## Closed-loop optimization · per-seed')
    L.push('')
    L.push('| Seed | J0 | Jend | J* | J/J* % | Iters | Governed writes | Rejected | Converged |')
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---|')
    for (const s of closedloop.seeds ?? []) {
      L.push(`| ${s.seed} | ${num(s.J0)} | ${num(s.Jend)} | ${num(s.Jstar)} | ${s.ratio != null ? (s.ratio * 100).toFixed(1) : '—'} | ${s.iters ?? s.stats?.iters ?? '—'} | ${s.writes ?? s.stats?.writes ?? '—'} | ${s.rejected ?? s.stats?.rejected ?? '—'} | ${(s.converged ?? s.stats?.converged) ? 'yes' : 'no'} |`)
    }
    L.push('')
  }
  L.push('## Execution artifacts (Agent-team trajectory archive)')
  L.push('')
  L.push('| Artifact | Size | Contents |')
  L.push('|---|---:|---|')
  for (const a of artifacts ?? []) L.push(`| \`${a.name}\` | ${(a.bytes / 1024).toFixed(1)} KB | ${HUMANIZE[a.name] ?? 'Execution / trajectory log (verbatim archive)'} |`)
  L.push('')
  L.push('## Check details')
  L.push('')
  for (const [ph, list] of [...byPhase.entries()].sort()) {
    L.push(`### ${ph} — ${PHASE_TITLES[ph] ?? ''}`)
    L.push('')
    for (const c of list) {
      const mark = c.status === 'pass' ? '✔' : c.status === 'warn' ? '▲' : c.status === 'skip' ? '↓' : '✘'
      L.push(`- ${mark} **${c.id}** (${c.status}) — ${c.title}`)
      for (const e of (c.evidence ?? []).slice(0, 4)) L.push(`  - ${String(e).replace(/\n/g, ' ').slice(0, 240)}`)
    }
    L.push('')
  }
  L.push('## Metric registry')
  L.push('')
  L.push('| Group | Metric | Value | Unit | Note |')
  L.push('|---|---|---:|---|---|')
  for (const m of metrics ?? []) L.push(`| ${m.section} | ${m.key} | ${m.value} | ${m.unit ?? ''} | ${m.note ?? ''} |`)
  L.push('')
  L.push('---')
  L.push(`_Machine-generated by \`bench/pipeline.mjs\` (verdict ${verdict}, grade ${effGrade}). The styled HTML panel is \`report.html\` in the same directory. Re-run under the same seed and compare judge-class outcomes with \`bench/compare.mjs\` against an archived baseline._`)
  return L.join('\n')
}
