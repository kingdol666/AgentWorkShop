/**
 * bench/lib/dashboard.mjs —— 一体化流水线的 HTML 可视化面板（自包含，无 CDN 依赖）。
 *
 * 与 lib/report.mjs（评分面板）分工：report.mjs 面向"能力评分"，
 * 本模块面向"集成流水线的量化结果"——阶段时间线、多产线对比、指标条形图、逐项证据。
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : '—')

export function barChart({ title, rows, unit = '', color = '#35e0a0', max }) {
  const items = (rows ?? []).filter(r => typeof r.value === 'number' && Number.isFinite(r.value))
  if (!items.length) return ''
  const hi = max ?? (Math.max(...items.map(r => r.value)) * 1.15 || 1)
  const H = 26, GAP = 10, LAB = 132, W = 560
  const h = items.length * (H + GAP) + 10
  const bars = items.map((r, i) => {
    const y = i * (H + GAP) + 6
    const w = Math.max(2, (r.value / hi) * (W - LAB - 60))
    const fill = r.color ?? color
    return `
      <text x="0" y="${y + 17}" class="bl">${esc(r.label)}</text>
      <rect x="${LAB}" y="${y}" width="${w}" height="${H}" rx="4" fill="${fill}" opacity="0.85"/>
      <text x="${LAB + w + 8}" y="${y + 17}" class="bv">${num(r.value)}${unit}</text>`
  }).join('')
  return `<div class="card"><h3>${esc(title)}</h3>
    <svg viewBox="0 0 ${W} ${h}" width="100%" style="max-width:${W}px">${bars}</svg></div>`
}

function kpiStrip(kpis) {
  return `<div class="kpis">${kpis.map(k => `
    <div class="kpi ${k.tone ?? ''}">
      <div class="kv">${esc(k.value)}<span class="ku">${esc(k.unit ?? '')}</span></div>
      <div class="kl">${esc(k.label)}</div>
      ${k.note ? `<div class="kn">${esc(k.note)}</div>` : ''}
    </div>`).join('')}</div>`
}

function phaseTimeline(phases) {
  return `<div class="card"><h3>Pipeline phases</h3><div class="phases">${phases.map(p => `
    <div class="ph ${p.status}">
      <div class="ph-id">${esc(p.id)}</div>
      <div class="ph-t">${esc(p.title)}</div>
      <div class="ph-m">${esc(p.note ?? '')}</div>
      <div class="ph-d">${num(p.durationMs / 1000)}s</div>
    </div>`).join('')}</div></div>`
}

export function renderDashboard({ env, phases, kpis, lines, charts, checks, metrics, closedloop }) {
  const pass = (checks ?? []).filter(c => c.status === 'pass').length
  const fail = (checks ?? []).filter(c => c.status === 'fail').length
  const warn = (checks ?? []).filter(c => c.status === 'warn').length
  const overallOk = env?.verdict ? env.verdict.ok === true : fail === 0
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>AgentWorkShop — Integrated Pipeline Report ${esc(env.runId)}</title>
<style>
  :root{--bg:#0b1220;--card:#111d2e;--card2:#152539;--line:#1e3550;--fg:#e8f1fa;--sub:#8ba3bd;
        --grn:#35e0a0;--cyn:#41c8f4;--amb:#e6b23c;--red:#ff6b6b;--pur:#a78bfa}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 "Segoe UI",system-ui,-apple-system,"Noto Sans SC",sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 22px 64px}
  header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;
    border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:22px}
  h1{font-size:21px;margin:0 0 6px}
  h3{font-size:13px;margin:0 0 12px;color:var(--sub);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
  .meta{color:var(--sub);font-size:12px;font-family:ui-monospace,Consolas,monospace}
  .verdict{font-size:13px;font-weight:700;padding:9px 16px;border-radius:999px;letter-spacing:.5px}
  .verdict.ok{background:rgba(53,224,160,.14);color:var(--grn);border:1px solid rgba(53,224,160,.4)}
  .verdict.bad{background:rgba(255,107,107,.14);color:var(--red);border:1px solid rgba(255,107,107,.4)}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .kpi .kv{font-size:26px;font-weight:800;color:var(--cyn);font-variant-numeric:tabular-nums}
  .kpi.good .kv{color:var(--grn)} .kpi.warn .kv{color:var(--amb)} .kpi.bad .kv{color:var(--red)}
  .ku{font-size:13px;color:var(--sub);margin-left:4px;font-weight:500}
  .kl{color:var(--sub);font-size:12px;margin-top:6px}
  .kn{color:#6f8aa6;font-size:11px;margin-top:3px;font-family:ui-monospace,monospace}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:18px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:880px){.grid2{grid-template-columns:1fr}}
  svg .bl{fill:var(--sub);font-size:12px;font-family:ui-monospace,monospace}
  svg .bv{fill:var(--fg);font-size:12px;font-family:ui-monospace,monospace}
  .phases{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px}
  .ph{background:var(--card2);border-radius:10px;padding:13px;border-left:3px solid var(--sub)}
  .ph.pass{border-left-color:var(--grn)} .ph.warn{border-left-color:var(--amb)}
  .ph.fail{border-left-color:var(--red)} .ph.skip{border-left-color:#4a5f78;opacity:.7}
  .ph-id{font-family:ui-monospace,monospace;font-size:11px;color:var(--sub)}
  .ph-t{font-size:13px;font-weight:600;margin:3px 0}
  .ph-m{font-size:11px;color:#7f97b0}
  .ph-d{font-size:11px;color:var(--cyn);margin-top:5px;font-family:ui-monospace,monospace}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--sub);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line);font-size:11.5px}
  td{padding:8px 10px;border-bottom:1px solid rgba(30,53,80,.5);font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  code{background:#0f1c2c;padding:1px 6px;border-radius:4px;font-size:12px;color:var(--cyn)}
  .ck{font-family:ui-monospace,monospace;font-size:12px}
  .ck.pass{color:var(--grn)} .ck.fail{color:var(--red)} .ck.warn{color:var(--amb)} .ck.skip{color:var(--sub)}
  .ev{color:#7f97b0;font-size:11.5px;margin:2px 0 0;overflow-wrap:anywhere;word-break:break-all}
  footer{color:#5d7590;font-size:11.5px;margin-top:30px;border-top:1px solid var(--line);padding-top:14px;
    font-family:ui-monospace,monospace;white-space:pre-wrap}
</style></head><body><div class="wrap">
  <header>
    <div>
      <h1>AgentWorkShop — Integrated Pipeline Report</h1>
      <div class="meta">run ${esc(env.runId)} · profile ${esc(env.profile)} · seed ${esc(env.seed)} · ${esc(env.lines)} lines / ${esc(env.protocols)} protocols</div>
      <div class="meta">platform ${esc(env.base)} · simulator ${esc(env.simBase)} · harness ${esc(String(env.harnessHash).slice(0, 8))} · git ${esc(env.gitCommit)}</div>
      <div class="meta">started ${esc(env.startedAt)} · node ${esc(env.node)} · ${esc(env.platform)}</div>
    </div>
    <div class="verdict ${overallOk ? 'ok' : 'bad'}">${overallOk ? 'ALL CHECKS PASS' : `${fail} CHECK(S) FAILED`} · pass ${pass} / warn ${warn} / fail ${fail}</div>
  </header>
  ${kpiStrip(kpis)}
  ${phaseTimeline(phases)}
  ${charts ? `<div class="grid2">${charts}</div>` : ''}
  <div class="card"><h3>Per-line detail</h3>
    <table><thead><tr>
      <th>#</th><th>Protocol</th><th>Sim device</th><th>DAQ samples</th><th>Write p50 (ms)</th>
      <th>Readback dev.</th><th>F5 block</th><th>Loop iters</th><th>Converge (s)</th><th>Agent</th>
    </tr></thead><tbody>
      ${(lines ?? []).map(l => `<tr>
        <td>${esc(l.index)}</td><td><code>${esc(l.protocol)}</code></td><td>${esc(l.simDeviceName ?? '')}</td>
        <td>${num(l.daqSamples)}</td><td>${num(l.writeP50)}</td><td>${num(l.readbackDelta)}</td>
        <td>${l.f5Rejected == null ? '—' : `${l.f5Rejected}/${l.f5Total}`}</td>
        <td>${num(l.loopIterations)}</td><td>${num(l.convergenceS)}</td><td>${esc(l.agentState ?? '—')}</td>
      </tr>`).join('')}
    </tbody></table>
  </div>
  <div class="card"><h3>Check results</h3>
    ${(checks ?? []).map(c => `<div style="margin-bottom:9px">
      <div class="ck ${c.status}">${c.status === 'pass' ? '✔' : c.status === 'warn' ? '▲' : c.status === 'skip' ? '↓' : '✘'} [${esc(c.phase)}] ${esc(c.id)} · ${esc(c.title)}</div>
      ${(c.evidence ?? []).slice(0, 6).map(e => `<div class="ev">${esc(String(e).length > 320 ? String(e).slice(0, 320) + `… (+${String(e).length - 320} chars, full value in run.json)` : e)}</div>`).join('')}
    </div>`).join('')}
  </div>
  ${closedloop?.seeds?.length
    ? `<div class="card"><h3>Closed-loop optimization benchmark (${esc(closedloop.writeMode)} write path)</h3>
    <div class="meta" style="margin-bottom:8px">J* (offline grid optimum) = ${num(closedloop.agg?.Jstar)} · attainment J/J*: min ${num((closedloop.agg?.ratioMin ?? 0) * 100)}% / mean ${num((closedloop.agg?.ratioMean ?? 0) * 100)}% / max ${num((closedloop.agg?.ratioMax ?? 0) * 100)}% · mean iters ${num(closedloop.agg?.itersMean)} · total writes ${num(closedloop.agg?.writesTotal)} · rejections ${num(closedloop.agg?.rejectedTotal)} · converged ${num(closedloop.agg?.convergedN)}/${num(closedloop.agg?.n)}</div>
    <table><thead><tr><th>seed</th><th>warmup (s)</th><th>J start</th><th>J end</th><th>J/J*</th><th>iters</th><th>writes</th><th>rej.</th><th>conv.</th><th>wall (s)</th></tr></thead><tbody>
      ${closedloop.seeds.map(s => `<tr>
        <td>${esc(s.seed)}</td><td>${num(s.warmupS)}</td><td>${num(s.J0)}</td><td><b>${num(s.Jend)}</b></td>
        <td>${s.ratio == null ? '—' : `${(s.ratio * 100).toFixed(1)}%`}</td>
        <td>${num(s.iters)}</td><td>${num(s.writes)}</td><td>${num(s.rejected)}</td>
        <td>${s.converged ? '✔' : '—'}</td><td>${num(s.wallS)}</td>
      </tr>`).join('')}
    </tbody></table>
  </div>`
    : ''}
  ${metrics?.length
    ? `<div class="card"><h3>Metric registry (paper/audit citation)</h3>
    <table><thead><tr><th>Section</th><th>Metric</th><th>Value</th><th>Unit</th><th>Note</th></tr></thead><tbody>
    ${metrics.map(m => `<tr><td>${esc(m.section)}</td><td><code>${esc(m.key)}</code></td><td>${num(m.value)}</td><td>${esc(m.unit)}</td><td>${esc(m.note)}</td></tr>`).join('')}
    </tbody></table></div>`
    : ''}
  <footer>Reproduce: ${esc(env.reproCmd ?? '')}
Artifacts: run.json / metrics.csv / summary.json / dashboard.html (append-only, never overwritten)
Judge-class metrics are bitwise-identical under a fixed seed; latency figures may vary with the environment.</footer>
</div></body></html>`
}
