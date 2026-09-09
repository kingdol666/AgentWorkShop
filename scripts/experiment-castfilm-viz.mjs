/**
 * 闭环实验可视化 —— result.json + truth.jsonl → 自包含 SVG 图表报告(report.html)。
 *
 * 用法:node scripts/experiment-castfilm-viz.mjs docs/experiments/results/castfilm-<tag>
 * 输出:<dir>/report.html(纯内联 SVG,无外部依赖,浏览器直开)
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node scripts/experiment-castfilm-viz.mjs <result-dir>')
  process.exit(1)
}
const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8'))
const truth = fs.existsSync(path.join(dir, 'truth.jsonl'))
  ? fs.readFileSync(path.join(dir, 'truth.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : []

// ---------- SVG 折线图 ----------
const W = 860
const H = 240
const PAD = { l: 56, r: 14, t: 26, b: 30 }

function lineChart({ series, bands = [], yMin, yMax, unit = '', title, hLines = [] }) {
  const n = Math.max(...series.map(s => s.data.length))
  if (!n) return `<div class="chart-empty">${title}:无数据</div>`
  const t0 = new Date(truth[0]?.t ?? Date.now()).getTime()
  const t1 = new Date(truth.at(-1)?.t ?? Date.now()).getTime()
  const span = Math.max(t1 - t0, 1)
  const lo = yMin ?? Math.min(...series.flatMap(s => s.data.filter(Number.isFinite)))
  const hi = yMax ?? Math.max(...series.flatMap(s => s.data.filter(Number.isFinite)))
  const padY = (hi - lo) * 0.08 || 1
  const y0 = lo - padY
  const y1 = hi + padY
  const X = t => PAD.l + ((new Date(t).getTime() - t0) / span) * (W - PAD.l - PAD.r)
  const Y = v => PAD.t + (1 - (v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b)
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart">`
  svg += `<text x="${PAD.l}" y="16" class="ct">${title}</text>`
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4
    const y = Y(v).toFixed(1)
    svg += `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" class="grid"/>`
    svg += `<text x="${PAD.l - 6}" y="${Number(y) + 4}" class="ax" text-anchor="end">${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}</text>`
  }
  for (const b of bands) {
    const x1 = X(b.from)
    const x2 = X(b.to)
    svg += `<rect x="${x1.toFixed(1)}" y="${PAD.t}" width="${Math.max(x2 - x1, 1).toFixed(1)}" height="${H - PAD.t - PAD.b}" fill="${b.color}" opacity="0.10"/>`
    svg += `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${b.label}</text>`
  }
  for (const h of hLines) {
    if (h.v < y0 || h.v > y1) continue
    svg += `<line x1="${PAD.l}" y1="${Y(h.v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(h.v).toFixed(1)}" stroke="${h.color}" stroke-dasharray="6 4" stroke-width="1.4"/>`
    svg += `<text x="${W - PAD.r - 4}" y="${(Y(h.v) - 5).toFixed(1)}" class="ax" text-anchor="end" fill="${h.color}">${h.label}</text>`
  }
  for (const s of series) {
    const pts = s.data.map((v, i) => v == null ? '' : `${X(new Date(truth[Math.min(i, truth.length - 1)]?.t ?? Date.now()).getTime()).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean)
    if (!pts.length) continue
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.6"/>`
  }
  svg += '</svg>'
  const legend = series.map(s => `<span class="lg"><i style="background:${s.color}"></i>${s.name}</span>`).join('')
    + hLines.map(h => `<span class="lg"><i style="background:transparent;border-bottom:2px dashed ${h.color};height:0"></i>${h.label}</span>`).join('')
  return svg + `<div class="legend">${legend}<span class="lg unit">${unit}</span></div>`
}

// ---------- 组装数据 ----------
const phaseBands = []
let cur = null
for (const s of truth) {
  if (!cur || cur.phase !== s.phase) {
    if (cur) phaseBands.push(cur)
    cur = { phase: s.phase, from: s.t }
  }
  cur.to = s.t
}
if (cur) phaseBands.push(cur)
const bands = phaseBands.map(b => ({ ...b, color: b.phase === 'warmup' ? '#41c8f4' : b.phase === 'steady' ? '#35e0a0' : b.phase === 'batch' ? '#f4b941' : '#f45e41' }))
const pick = (obj, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj)
const series = (p, color, name) => ({ name, color, data: truth.map(s => pick(s, p)) })

const charts = [
  lineChart({
    title: '① 熔体温度(真值 vs 协议暴露值)',
    series: [series('truth.meltTemp', '#41c8f4', '真值'), series('exposed.meltTemp', '#8ab4ff', 'Agent 可见')],
    bands, hLines: [{ v: 195, color: '#f4b941', label: '工艺窗下限 195℃' }, { v: 225, color: '#f4b941', label: '上限 225℃' }],
    unit: '℃',
  }),
  lineChart({
    title: '② 平均膜厚 h(质量守恒:∝ N/v)+ 合格窗',
    series: [series('truth.thickness', '#35e0a0', '真值'), series('exposed.thickness', '#8affd0', 'Agent 可见')],
    bands,
    hLines: [{ v: 48, color: '#35e0a0', label: '合格窗 48' }, { v: 52, color: '#35e0a0', label: '52' }, { v: result.optimum?.thickness ?? 50, color: '#f45e41', label: `W* h=${result.optimum?.thickness ?? 50}` }],
    unit: 'μm',
  }),
  lineChart({
    title: '③ 品质与安全(缺陷率 / 熔体压力)',
    series: [series('truth.defect', '#f4b941', '缺陷率%'), series('exposed.pressure', '#f45e41', '压力MPa')],
    bands, hLines: [{ v: 2, color: '#f4b941', label: '缺陷率目标 2%' }, { v: 22, color: '#f45e41', label: '压力安全 22MPa' }],
    unit: '% / MPa',
  }),
  lineChart({
    title: '④ 控制输入轨迹(SP,Agent 下发经真实协议)',
    series: [
      series('sp.zone3', '#41c8f4', '区3温度℃(÷3 显示)'),
      { name: '螺杆rpm(÷2)', color: '#35e0a0', data: truth.map(s => s.sp.screw / 2) },
      { name: '线速m/min', color: '#f4b941', data: truth.map(s => s.sp.lineSpeed) },
    ],
    bands,
    unit: '组合刻度(区3/3、螺杆/2、线速)',
  }),
]

const kpi = result.convergence ?? {}
const win = result.windows ?? {}
const sc = result.scores ?? {}
const rows = [
  ['收敛交付', kpi.convLine ?? '—'],
  ['稽核结论', kpi.auditLine ?? '—'],
  ['HITL 审批', `${kpi.approvals?.count ?? 0} 次(时延 p50 ≈ ${pct(kpi.approvals?.latencies, 0.5)}ms)`],
  ['膜厚窗(末 3min)', fmtWin(win.thickness, 'μm')],
  ['缺陷率窗', fmtWin(win.defect, '%')],
  ['压力窗峰值', fmtWin(win.pressure, 'MPa')],
  ['J(W_agent) / J(W*)', `${sc.agentJ?.toFixed?.(2) ?? '?'} / ${sc.optimumJ ?? '?'} = ${(100 * (sc.ratio ?? 0)).toFixed(1)}%`],
  ['离线最优 W*', `T=${result.optimum?.zoneTemp}℃ N=${result.optimum?.screw}rpm v=${result.optimum?.lineSpeed}m/min → h*=${result.optimum?.thickness}μm 缺陷 ${result.optimum?.defect}%`],
  ['起点工况(次优)', `zone=${result.start?.zone}℃ N=${result.start?.screw}rpm v=${result.start?.lineSpeed}m/min(理论 h≈53.9μm 偏厚)`],
  ['可复现性', `seed=${result.seed} timeScale=${result.timeScale}× 同 seed 重跑逐点一致`],
  ['总时长', `${Math.round((result.durationS ?? 0) / 60)} min(${result.pass} PASS / ${result.fail} FAIL)`],
]
function pct(a, p) {
  if (!a?.length) return '?'
  const s = [...a].sort((x, y) => x - y)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))])
}
function fmtWin(w, unit) {
  if (!w) return '—'
  return `均值 ${w.avg?.toFixed?.(2)}${unit}(min ${w.min?.toFixed?.(1)} / max ${w.max?.toFixed?.(1)},n=${w.n})`
}

const checks = (result.checks ?? []).map(c =>
  `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${c.name}${c.extra ? ` — ${c.extra}` : ''}</li>`).join('')

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>挤出流延闭环实验报告 · ${result.tag}</title><style>
body{background:#0b1220;color:#dbe6f4;font-family:"Segoe UI",system-ui,sans-serif;margin:0;padding:32px}
h1{font-size:22px;color:#35e0a0;margin:0 0 4px} h2{font-size:15px;color:#41c8f4;margin:28px 0 10px}
.sub{color:#7c8db0;font-size:12px;margin-bottom:24px}
.chart{width:100%;max-width:980px;background:#0e1626;border:1px solid #1c2a44;border-radius:10px;display:block}
.legend{font-size:12px;color:#9fb0cf;margin:6px 0 18px;display:flex;gap:14px;flex-wrap:wrap}
.lg i{display:inline-block;width:14px;height:3px;margin-right:5px;vertical-align:middle}
.grid{stroke:#16233c;stroke-width:1}.ct{fill:#9fb0cf;font-size:13px}.ax{fill:#5d6f93;font-size:10px}
table{border-collapse:collapse;font-size:13px;max-width:980px;width:100%}
td,th{border:1px solid #1c2a44;padding:7px 12px;text-align:left;vertical-align:top}
th{color:#41c8f4;background:#0e1626;width:220px}td{color:#dbe6f4}
ul.checks{columns:2;max-width:980px;font-size:12px;padding-left:18px;margin:0}
li.ok{color:#35e0a0}li.bad{color:#f45e41}
.chart-empty{color:#5d6f93;font-size:13px;padding:20px}
.badge{display:inline-block;background:#0e1626;border:1px solid #1c2a44;border-radius:6px;padding:2px 10px;font-size:12px;color:#41c8f4;margin-right:8px}
</style></head><body>
<h1>挤出流延薄膜产线 · AgentTeam 闭环优化实验</h1>
<div class="sub">tag=${result.tag} · seed=${result.seed} · timeScale=${result.timeScale}× · ${result.startedAt} · 时长 ${Math.round((result.durationS ?? 0) / 60)} min · <span class="badge">${result.pass} PASS</span><span class="badge">${result.fail} FAIL</span></div>
${charts.join('\n')}
<h2>关键指标</h2>
<table>${rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('')}</table>
<h2>检查项(${result.pass}/${result.pass + result.fail})</h2>
<ul class="checks">${checks}</ul>
<p class="sub" style="margin-top:24px">物理真值曲线来自 plc-node-simulator plant-model(未加噪状态方程积分);「Agent 可见」= 协议暴露值(传感器噪声后)。复现:NO_PROXY='127.0.0.1,localhost' node scripts/experiment-castfilm-closedloop.mjs</p>
</body></html>`

fs.writeFileSync(path.join(dir, 'report.html'), html)
console.log(`report → ${path.join(dir, 'report.html')}(truth ${truth.length} 样本)`)
