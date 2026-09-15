/**
 * bench/lib/report.mjs — report renderer: run.json → report.md + report.html
 * Standard English benchmark report. Theme: control-room dark (deep navy +
 * green #35e0a0 + data cyan #41c8f4). Pure inline SVG/CSS, zero dependencies.
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const STATUS = {
  pass: { icon: '✔', label: 'PASS', color: '#35e0a0' },
  warn: { icon: '▲', label: 'WARN', color: '#f4b941' },
  fail: { icon: '✘', label: 'FAIL', color: '#f45c5c' },
  skip: { icon: '↓', label: 'SKIP', color: '#5b7290' },
}
const DIM_NAMES = {
  D0: 'Paper–code consistency', D1: 'Data acquisition', D2: 'Write-control governance', D3: 'Agent runtime',
  D4: 'Orchestration', D5: 'Memory & context', D6: 'Interoperability', D7: 'Audit & attribution', D8: 'Performance & scale',
}
const short8 = (s) => String(s ?? '').slice(0, 8)
const fmtMetrics = (m) => Object.entries(m ?? {}).map(([k, v]) => `${k}=<b>${esc(v)}</b>`).join(' · ') || '—'

function radarSvg(dims, size = 260) {
  const n = dims.length
  if (n < 3) return ''
  const cx = size / 2, cy = size / 2, R = size / 2 - 42
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }
  const axes = dims.map((d, i) => {
    const [x, y] = pt(i, R)
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#233b5c" stroke-width="1"/>
      <text x="${(cx + (R + 16) * Math.cos(-Math.PI / 2 + 2 * Math.PI * i / n)).toFixed(1)}" y="${(cy + (R + 16) * Math.sin(-Math.PI / 2 + 2 * Math.PI * i / n)).toFixed(1)}" fill="#8fb0d0" font-size="10" text-anchor="middle" dominant-baseline="middle">${d.id} ${(d.score * 100).toFixed(0)}</text>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#233b5c"/>`
  }).join('')
  const poly = dims.map((d, i) => pt(i, R * Math.max(0.04, d.score)).map(v => v.toFixed(1)).join(',')).join(' ')
  const rings = [0.25, 0.5, 0.75, 1].map(f => {
    const pts = dims.map((_, i) => pt(i, R * f).map(v => v.toFixed(1)).join(',')).join(' ')
    return `<polygon points="${pts}" fill="none" stroke="#1a2f4a" stroke-width="1"/>`
  }).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rings}${axes}<polygon points="${poly}" fill="rgba(53,224,160,0.22)" stroke="#35e0a0" stroke-width="2"/></svg>`
}

function barSvg(score, w = 190, h = 12) {
  const c = score >= 0.9 ? '#35e0a0' : score >= 0.6 ? '#f4b941' : '#f45c5c'
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;margin-top:6px"><rect width="${w}" height="${h}" rx="6" fill="#142640"/><rect width="${(w * Math.max(0.02, score)).toFixed(1)}" height="${h}" rx="6" fill="${c}"/></svg>`
}

export function renderReport({ env, dims, results }) {
  const s = STATUS
  const overallPct = env.total.overall * 100
  const grade = overallPct >= 90 ? 'A' : overallPct >= 75 ? 'B' : overallPct >= 60 ? 'C' : overallPct > 0 ? 'D' : '—'
  const verdict = env.total.fail > 0 ? 'FAILED — do not cite' : env.total.pass > 0 ? 'ALL CHECKS PASSED' : 'NOT EVALUATED'
  const verdictColor = env.total.fail > 0 ? 'var(--red)' : 'var(--grn)'
  const repCmd = `node bench/run.mjs --tier ${env.tier} --seed ${env.seed}${env.tier !== 'static' ? ` --base ${env.base}` : ''}`

  // ── Markdown ──
  const md = [`# AW-IndustrialBench — Benchmark Report`, '',
    `**Run** \`${env.runId}\`  ·  **Verdict:** ${verdict}  ·  **Overall score ${overallPct.toFixed(1)}/100 (grade ${grade})**`,
    '', '| Field | Value |', '|---|---|',
    `| Tier | \`${env.tier}\` |`,
    `| Seed | \`${env.seed}\` |`,
    `| Target | \`${env.base}\` |`,
    `| Config hash | \`${env.configHash}\` |`,
    `| Harness hash | \`${env.harnessHash ?? '—'}\` (${env.harnessFiles ?? '?'} sources, SHA-256) |`,
    `| Repository commit | \`${env.gitCommit ?? '—'}\` |`,
    `| Node / platform | ${env.node} · ${env.platform} |`,
    `| Completed at | ${env.startedAt} |`, '',
    `**Tally:** ${env.total.pass} pass · ${env.total.warn} warn · ${env.total.fail} fail · ${env.total.skip} skip (skips score nothing, by design).`,
    '', '## Dimension scores', '',
    '| Dimension | Score | Checks |', '|---|---|---|',
    ...dims.map(d => `| ${d.id} ${DIM_NAMES[d.id] ?? d.id} | ${(d.score * 100).toFixed(1)} | ${d.checks} |`), '',
    '## Check results', '',
    '| Check | Tier | Status | Score | Key metrics | Note |', '|---|---|---|---|---|---|',
    ...results.map(r => `| \`${r.id}\` ${esc(r.title)} | ${r.tier} | ${s[r.status].icon} ${s[r.status].label} | ${(r.score * 100).toFixed(0)} | ${fmtMetrics(r.metrics)} | ${esc(r.note)} |`), '',
    '## Evidence excerpts', '',
    ...results.filter(r => r.evidence?.length && r.status !== 'skip').flatMap(r => [`### \`${r.id}\` ${esc(r.title)}`, '', ...r.evidence.map(e => `- ${esc(e)}`), '']),
    results.filter(r => r.status === 'skip').length ? ['## Skipped checks (with reasons)', '', ...results.filter(r => r.status === 'skip').map(r => `- **${r.id}** ${esc(r.note)}`)].flat().join('\n') : '',
    '', '---', '',
    '**Reproduce:**', '', '```bash', repCmd, '```', '',
    `Artifacts: \`bench/results/${env.runId}/\` (run.json · report.md · report.html). Results are append-only — runs are never overwritten, so this report can be cited as experimental evidence. Judge-class metrics are deterministic under a fixed seed; environment-dependent figures (latency, freshness) are reported as measured.`,
  ].flat().filter(x => x !== '').join('\n')

  // ── HTML ──
  const dimCards = dims.map(d => `
    <div class="card"><div class="dim-id">${d.id}</div><div class="dim-name">${DIM_NAMES[d.id] ?? d.id}</div>
    <div class="dim-score" style="color:${d.score >= 0.9 ? '#35e0a0' : d.score >= 0.6 ? '#f4b941' : '#f45c5c'}">${(d.score * 100).toFixed(0)}</div>
    ${barSvg(d.score)}<div class="dim-checks">${d.checks} check${d.checks === 1 ? '' : 's'}</div></div>`).join('')

  const rows = results.map(r => `
    <tr class="row-${r.status}">
      <td><b>${r.id}</b><div class="sub">${esc(r.title)}</div></td>
      <td><span class="pill pill-${r.tier}">${r.tier}</span></td>
      <td><span class="st" style="color:${s[r.status].color}">${s[r.status].icon} ${s[r.status].label}</span></td>
      <td>${(r.score * 100).toFixed(0)}</td>
      <td class="mono">${fmtMetrics(r.metrics)}</td>
      <td class="sub">${esc(r.note)}</td>
    </tr>`).join('')

  const evidenceBlocks = results.filter(r => r.evidence?.length && r.status !== 'skip').map(r => `
    <details ${r.status === 'fail' ? 'open' : ''}><summary><b>${r.id}</b> ${esc(r.title)} <span style="color:${s[r.status].color}">${s[r.status].icon}</span></summary>
    <ul>${r.evidence.map(e => `<li class="mono">${esc(e)}</li>`).join('')}</ul></details>`).join('')

  const fingerprint = [
    ['seed', env.seed], ['tier', env.tier], ['target', env.base], ['config hash', env.configHash],
    ['harness hash', env.harnessHash ? `${short8(env.harnessHash)} (${env.harnessFiles ?? '?'} files)` : '—'],
    ['commit', env.gitCommit], ['node', env.node], ['platform', env.platform], ['completed', env.startedAt],
  ].map(([k, v]) => `<div class="fp"><span>${k}</span><b class="mono">${esc(v)}</b></div>`).join('')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>AW-IndustrialBench — Benchmark Report · ${env.runId}</title><style>
  :root{--bg:#0b1526;--panel:#101f35;--line:#1c3350;--tx:#dbe7f4;--sub:#8fb0d0;--grn:#35e0a0;--cyn:#41c8f4;--amb:#f4b941;--red:#f45c5c}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 "Segoe UI",system-ui,sans-serif;padding:28px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:22px;margin:0 0 2px}h1 .badge{color:var(--grn)}
  .tagline{color:var(--sub);font-size:12px;margin-bottom:16px}.mono{font-family:Consolas,Menlo,monospace;font-size:12px}
  .hero{display:flex;gap:18px;align-items:center;background:linear-gradient(135deg,#0f2138,#0c1a2e);border:1px solid var(--line);border-radius:14px;padding:22px 26px;margin-bottom:14px}
  .verdict{font-size:12px;font-weight:800;letter-spacing:2px;color:${verdictColor};border:1px solid ${verdictColor};border-radius:20px;padding:3px 12px;display:inline-block;margin-bottom:8px}
  .score-big{font-size:56px;font-weight:800;color:var(--grn);line-height:1}
  .score-cap{color:var(--sub);font-size:12px;letter-spacing:2px}
  .grade{font-size:30px;font-weight:800;color:var(--cyn);border:2px solid var(--cyn);border-radius:12px;padding:4px 14px;margin-left:auto}
  .stats{display:flex;gap:16px;margin-left:26px}
  .stat{text-align:center}.stat b{display:block;font-size:20px}.stat span{font-size:11px;color:var(--sub)}
  .fingerprint{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px 18px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 18px;margin-bottom:22px}
  .fp{display:flex;justify-content:space-between;gap:10px;font-size:12px}.fp span{color:var(--sub)}.fp b{color:var(--tx);font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center}
  .dim-id{color:var(--cyn);font-weight:800;font-size:15px}.dim-name{color:var(--sub);font-size:11px;min-height:16px}
  .dim-score{font-size:30px;font-weight:800;margin:4px 0}.dim-checks{color:var(--sub);font-size:11px;margin-top:6px}
  .radar{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px;display:flex;justify-content:center}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:22px}
  th{background:#13253f;color:var(--sub);font-size:12px;text-align:left;padding:10px 12px;letter-spacing:1px}
  td{border-top:1px solid var(--line);padding:10px 12px;vertical-align:top}
  .row-fail{background:rgba(244,92,92,.07)}.row-warn{background:rgba(244,185,65,.05)}
  .pill{display:inline-block;border-radius:20px;padding:1px 10px;font-size:11px;font-weight:700}
  .pill-static{background:#12325a;color:var(--cyn)}.pill-api{background:#0f3a2c;color:var(--grn)}.pill-full{background:#3a2a10;color:var(--amb)}.pill-plc{background:#2a1038;color:#c79bf2}
  .st{font-weight:800;white-space:nowrap}
  .sub{color:var(--sub);font-size:12px}
  details{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:8px}
  summary{cursor:pointer}ul{margin:8px 0 2px}li{margin:3px 0;color:#b9cde3}
  .foot{color:var(--sub);font-size:12px;margin-top:18px}.foot code{color:var(--grn)}
</style></head><body><div class="wrap">
  <h1>AW-IndustrialBench <span class="badge">— Benchmark Report</span></h1>
  <div class="tagline mono">Governed-autonomy evaluation of AgentWorkShop · deterministic, seeded, append-only results</div>
  <div class="hero">
    <div><div class="verdict">${verdict}</div><div class="score-big">${overallPct.toFixed(1)}</div><div class="score-cap">OVERALL SCORE / 100</div></div>
    <div class="grade">${grade}</div>
    <div class="stats" style="margin-left:0">
      <div class="stat"><b style="color:var(--grn)">${env.total.pass}</b><span>PASS</span></div>
      <div class="stat"><b style="color:var(--amb)">${env.total.warn}</b><span>WARN</span></div>
      <div class="stat"><b style="color:var(--red)">${env.total.fail}</b><span>FAIL</span></div>
      <div class="stat"><b style="color:var(--sub)">${env.total.skip}</b><span>SKIP</span></div>
    </div>
    <div class="radar" style="margin-left:auto">${radarSvg(dims) || '<div class="sub">not enough dimensions</div>'}</div>
  </div>
  <div class="fingerprint">${fingerprint}</div>
  <div class="grid">${dimCards}</div>
  <table><thead><tr><th style="width:22%">Check</th><th>Tier</th><th>Status</th><th>Score</th><th style="width:30%">Key metrics</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>
  <h3 style="margin:0 0 10px">Evidence</h3>
  ${evidenceBlocks || '<div class="sub">none</div>'}
  <div class="foot">Reproduce: <code>${esc(repCmd)}</code><br>
  Artifacts: <code>bench/results/${env.runId}/</code> (run.json · report.md · report.html) — append-only, never overwritten; cite this run id as evidence. Judge-class metrics are bitwise-reproducible under the fixed seed; latency/freshness figures are environment-dependent and reported as measured. Compare any two runs with <code>node bench/compare.mjs --baseline 20260914-baseline/run-plc-fx0 --b ${env.runId}</code>.</div>
</div></body></html>`

  return { md, html }
}
