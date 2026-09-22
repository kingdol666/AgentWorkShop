/**
 * bench/lib/scenario-report.mjs —— 多场景并行闭环基准报告(MD + HTML,零手敲数字)。
 * 单一事实源 = run 对象(见 bench/scenarios.mjs);MD 供贴 PR/审计,HTML 供浏览器/打印。
 */
import { writeJson, writeText } from './util.mjs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r2 = (v) => Number(Number(v).toFixed(2))
const fmt = (v, d = 2) => (v == null || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(d)

function verdictOf(run) {
  const bad = run.results.filter(r => r.errors.length || !r.mission?.attained)
  return bad.length === 0 ? 'PASS' : 'FAIL'
}

export function renderScenariosReportMd(run) {
  const M = []
  const v = verdictOf(run)
  M.push(`# AW-IndustrialBench · 多场景并行闭环优化基准报告`)
  M.push(``)
  M.push(`> **判定:${v}** · run \`${run.runId}\` · ${run.at} · wall ${run.wallS}s · 并行 ${run.results.length} 场景(各一产线/一 Channel/一工具执行器,Promise.all 同时闭环)`)
  M.push(`> platform=${run.base} · simulator=${run.simBase} · toolHarness=${run.toolHarness} · git=${run.gitCommit} · harness=${run.harnessHash}`)
  M.push(``)
  M.push(`被测场景与控制问题形态(与 BOPET 双拉/流延薄膜互补):`)
  M.push(``)
  M.push(`| 场景 | 作业故事 | 被控量 | 目标 | 达标 | 写次数 | 轨迹轮次 | 耗时(s) |`)
  M.push(`|---|---|---|---|---|---|---|---|`)
  for (const r of run.results) {
    const m = r.mission ?? {}
    const pv = r.pv ?? {}
    M.push(`| ${r.id}(${r.zh}) | ${(r.story ?? '').slice(0, 60)}… | ${pv.label ?? ''} | ${pv.target != null ? `${pv.target}±${pv.tol}${pv.unit}` : ''} | ${m.attained ? '✔' : '✘'} | ${m.writes ?? '—'} | ${m.rounds ?? '—'} | ${r.wallS ?? '—'} |`)
  }
  M.push(``)
  M.push(`## 1. 接入过程(差分 ensure → 平台建线,幂等)`)
  for (const r of run.results) {
    M.push(``)
    M.push(`### ${r.id} · ${r.zh}`)
    M.push(`- 模拟器侧:${JSON.stringify(r.ensure ?? {})}`)
    M.push(`- 终验:${JSON.stringify(r.verified ?? {})}`)
    M.push(`- 平台侧:${r.line ? `${r.line.reused ? '复用既有产线' : '新建产线'} \`${r.line.name ?? ''}\` line=${r.line.ids?.lineId} recipe=${r.line.ids?.recipeId} DCW=${r.line.dcw} DAQ=${r.line.daq}${r.line.errors?.length ? ` 错误:${r.line.errors.join(';')}` : ''}` : '未执行'}`)
    M.push(`- 驱动实测:${(r.line?.driverTests ?? []).map(t => `${t.device}/${t.signal} ${t.ok ? '✔' : '✘'}`).join(' · ') || '—'}`)
    M.push(`- Channel:${r.channel ? `channel=${r.channel.chId} toolAgent=${r.channel.instId} task=${r.channel.parentTask} 终态=${r.channel.terminal ?? '(观察窗内未终)'}` : '—'}`)
  }
  M.push(``)
  M.push(`## 2. 闭环优化过程(全轨迹)`)
  for (const r of run.results) {
    M.push(``)
    M.push(`### ${r.id} · ${r.zh}`)
    M.push(``)
    M.push(`| 轮 | 阶段 | 旋钮 | 写前→写后 | PV(被控量) | 记录 | 判定 |`)
    M.push(`|---|---|---|---|---|---|---|`)
    for (const t of (r.mission?.traj ?? [])) {
      M.push(`| ${t.iter} | ${t.phase ?? ''} | ${t.knob ?? '—'} | ${t.from != null ? `${t.from} → ${t.to}` : '—'} | ${t.pv != null ? fmt(t.pv) + (r.pv?.unit ? ` ${r.pv.unit}` : '') : '—'} | ${t.record ? 'yes' : '—'} | ${t.judge === undefined ? '' : (t.judge ? 'keep ✔' : '✘')} |`)
    }
    M.push(``)
    for (const e of (r.mission?.ev ?? [])) M.push(`- ${e}`)
    if (r.id === 'wwtp' && r.mission?.cost) {
      M.push(`- **成本曲线**:首个达标运行成本 ≈${fmt(r.mission.cost.firstCompliant, 1)} → 终态 ≈${fmt(r.mission.cost.final, 1)}(降 ${fmt(r.mission.cost.saving, 1)},在排放达标约束内「脱气退药」)`)
    }
    if (r.id === 'anneal' && r.mission?.throughput) {
      M.push(`- **产能曲线**:线速 ${fmt(r.mission.throughput.start, 0)} → ${fmt(r.mission.throughput.finalSp, 0)} m/min(+${fmt(r.mission.throughput.gain, 1)}%,质量窗触边自动回退)`)
    }
    if (r.mission?.guardsFinal && Object.keys(r.mission.guardsFinal).length) {
      M.push(`- 守卫终值:${Object.entries(r.mission.guardsFinal).map(([k, v2]) => `${k}=${fmt(v2)}`).join(' · ')}`)
    }
    if (r.errors.length) M.push(`- ⚠ 错误:${r.errors.join(';')}`)
  }
  M.push(``)
  M.push(`## 3. 诚实边界`)
  M.push(`- 全部写路径经平台治理(dcw_control 自动开优化记录 + dcw_judge 判定收口);策略为确定性脚本(不经 LLM),与真实 LLM 变体共用同一工具面与治理链路。`)
  M.push(`- 物理数据由模拟器多引擎(cast-film/biax/injection/wwtp/anneal)产出,同 seed 确定性;J/W* 与真实产线存在仿真层级边界。`)
  M.push(`- 平台侧产线为「复用优先」:本报告如显示 reused,说明前次接入仍在,本次零重复建线(设计语义)。`)
  M.push(``)
  M.push(`## 4. 复现`)
  M.push(``)
  M.push('```bash')
  M.push(`NO_PROXY=127.0.0.1,localhost \\`)
  M.push(`AW_BASE=${run.base} SIM_BASE=${run.simBase} \\`)
  M.push(`  node bench/scenarios.mjs --seed ${run.seed} --tool-harness ${run.toolHarness}`)
  M.push('```')
  M.push(``)
  return M.join('\n') + '\n'
}

const CSS = `
:root{--bg:#0c1220;--card:#121a2c;--line:#1f2b45;--fg:#dfe7f5;--dim:#8fa0bd;--ok:#35e0a0;--warn:#f4b350;--bad:#f4636c;--accent:#41c8f4}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Segoe UI",system-ui,sans-serif;padding:32px}
.wrap{max-width:1180px;margin:0 auto}
.stamp{display:inline-block;padding:8px 26px;border:2px solid var(--ok);color:var(--ok);font-size:26px;font-weight:800;letter-spacing:6px;border-radius:6px;transform:rotate(-2deg)}
.stamp.fail{border-color:var(--bad);color:var(--bad)}
h1{font-size:22px;margin:18px 0 6px}
h2{font-size:17px;margin:28px 0 10px;border-left:4px solid var(--accent);padding-left:10px}
h3{font-size:15px;margin:18px 0 8px;color:var(--accent)}
.meta{color:var(--dim);font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card .k{color:var(--dim);font-size:12px}
.card .v{font-size:22px;font-weight:700;margin-top:4px}
.card .v.ok{color:var(--ok)}.card .v.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:600;white-space:nowrap}
tr:hover td{background:#16203a}
.ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.dim{color:var(--dim)}
code,pre{font-family:Consolas,Menlo,monospace;font-size:12.5px}
pre{background:#0a101d;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}
.story{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;color:var(--dim)}
.kv{margin:4px 0}
.kv b{color:var(--fg)}
@media print{body{background:#fff;color:#111}.card,pre,.story{background:#f5f5f5;border-color:#ddd}th,td{border-color:#ddd}.dim{color:#555}}
`

function trajTableHtml(r) {
  const rows = (r.mission?.traj ?? []).map((t) => `<tr>
    <td>${esc(t.iter)}</td><td>${esc(t.phase ?? '')}</td><td>${esc(t.knob ?? '—')}</td>
    <td>${t.from != null ? esc(t.from) + ' → ' + esc(t.to) : '<span class="dim">—</span>'}</td>
    <td>${t.pv != null ? esc(fmt(t.pv)) + ' ' + esc(r.pv?.unit ?? '') : '<span class="dim">—</span>'}</td>
    <td>${t.record ? '<span class="ok">已开窗</span>' : '<span class="dim">—</span>'}</td>
    <td>${t.judge === undefined ? '' : (t.judge ? '<span class="ok">keep ✔</span>' : '<span class="bad">✘</span>')}</td>
  </tr>`).join('')
  return `<table><thead><tr><th>轮</th><th>阶段</th><th>旋钮</th><th>写前→写后</th><th>PV(${esc(r.pv?.label ?? '')})</th><th>优化记录</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`
}

export function renderScenariosReportHtml(run) {
  const v = verdictOf(run)
  const cards = run.results.map((r) => `
    <div class="card">
      <div class="k">${esc(r.id)} · ${esc(r.zh)}</div>
      <div class="v ${r.mission?.attained ? 'ok' : 'bad'}">${r.mission?.attained ? '达标 ✔' : '未达标 ✘'}</div>
      <div class="k">writes=${esc(r.mission?.writes)} · rounds=${esc(r.mission?.rounds)} · ${esc(r.wallS)}s · 线${r.line?.reused ? '(复用)' : '(新建)'}</div>
    </div>`).join('')
  const sections = run.results.map((r) => {
    const m = r.mission ?? {}
    const extras = []
    if (r.id === 'wwtp' && m.cost) extras.push(`<div class="kv">成本曲线:首个达标 ≈<b>${esc(fmt(m.cost.firstCompliant, 1))}</b> → 终态 ≈<b>${esc(fmt(m.cost.final, 1))}</b>(降 ${esc(fmt(m.cost.saving, 1))},达标约束内退气退药)</div>`)
    if (r.id === 'anneal' && m.throughput) extras.push(`<div class="kv">产能曲线:线速 <b>${esc(fmt(m.throughput.start, 0))}</b> → <b>${esc(fmt(m.throughput.finalSp, 0))}</b> m/min(+${esc(fmt(m.throughput.gain, 1))}%,质量窗触边自动回退)</div>`)
    if (m.guardsFinal && Object.keys(m.guardsFinal).length) {
      extras.push(`<div class="kv">守卫终值:${Object.entries(m.guardsFinal).map(([k, v2]) => `<b>${esc(k)}</b>=${esc(fmt(v2))}`).join(' · ')}</div>`)
    }
    return `<h2>${esc(r.id)} · ${esc(r.zh)}</h2>
    <div class="story">${esc(r.story ?? '')}</div>
    <h3>接入(幂等)</h3>
    <div class="kv">模拟器侧:<span class="dim">${esc(JSON.stringify(r.ensure ?? {}))}</span></div>
    <div class="kv">终验:<span class="dim">${esc(JSON.stringify(r.verified ?? {}))}</span></div>
    <div class="kv">平台侧:<b>${r.line?.reused ? '复用既有产线' : '新建产线'}</b> <span class="dim">${esc(r.line?.name ?? '')} · line=${esc(r.line?.ids?.lineId)} · recipe=${esc(r.line?.ids?.recipeId)} · DCW=${esc(r.line?.dcw)} · DAQ=${esc(r.line?.daq)}</span></div>
    <div class="kv">驱动实测:${(r.line?.driverTests ?? []).map((t) => `${esc(t.device)} ${t.ok ? '<span class="ok">✔</span>' : '<span class="bad">✘</span>'}`).join(' · ') || '—'}</div>
    <div class="kv">Channel:<span class="dim">channel=${esc(r.channel?.chId)} · toolAgent=${esc(r.channel?.instId)} · task=${esc(r.channel?.parentTask)} · 终态=${esc(r.channel?.terminal ?? '(观察窗内未终)')}</span></div>
    <h3>闭环轨迹(writes=${esc(m.writes)} · rounds=${esc(m.rounds)})</h3>
    ${trajTableHtml(r)}
    <pre>${esc((m.ev ?? []).join('\n'))}</pre>
    ${extras.join('\n')}
    ${r.errors.length ? `<div class="bad">⚠ ${esc(r.errors.join(';'))}</div>` : ''}`
  }).join('\n')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>多场景并行闭环基准 · ${esc(run.runId)}</title><style>${CSS}</style></head><body><div class="wrap">
<div class="stamp ${v === 'PASS' ? '' : 'fail'}">${v}</div>
<h1>AW-IndustrialBench · 多场景并行闭环优化基准</h1>
<div class="meta">run <code>${esc(run.runId)}</code> · ${esc(run.at)} · 并行 ${esc(run.results.length)} 场景(Promise.all 同时闭环) · wall ${esc(run.wallS)}s<br>
platform=<code>${esc(run.base)}</code> · simulator=<code>${esc(run.simBase)}</code> · toolHarness=${esc(run.toolHarness)} · seed=${esc(run.seed)} · git=${esc(run.gitCommit)} · harness=${esc(run.harnessHash)}</div>
<div class="cards">${cards}</div>
${sections}
<h2>诚实边界</h2>
<div class="kv dim">· 全部写经平台治理(dcw_control 开优化记录 + dcw_judge 判定);策略为确定性脚本,与 LLM 变体共用同一工具面/治理链路。</div>
<div class="kv dim">· 物理数据由模拟器多引擎产出,同 seed 确定性;与真实产线存在仿真层级边界。</div>
<div class="kv dim">· 平台产线复用优先:reused = 前次接入仍在,本次零重复建线(设计语义)。</div>
<h2>复现</h2>
<pre>NO_PROXY=127.0.0.1,localhost AW_BASE=${esc(run.base)} SIM_BASE=${esc(run.simBase)} node bench/scenarios.mjs --seed ${esc(run.seed)} --tool-harness ${esc(run.toolHarness)}</pre>
</div></body></html>`
}

/** 落盘完整报告组(MD + HTML + JSON 轨迹 + 每场景过程日志) */
export function writeScenarioReports(outDir, run, { writeText: wt = writeText, writeJson: wj = writeJson } = {}) {
  wt(`${outDir}/scenarios-benchmark.md`, renderScenariosReportMd(run))
  wt(`${outDir}/scenarios-benchmark.html`, renderScenariosReportHtml(run))
  wj(`${outDir}/scenarios.json`, run)
  for (const r of run.results) {
    const lines = [
      `AW-IndustrialBench · scenario ${r.id} (${r.zh}) — mission trace`,
      `run: ${run.runId}  channel: ${r.channel?.chId}  toolAgent: ${r.channel?.instId}  task: ${r.channel?.parentTask}`,
      `line: ${r.line?.name} (${r.line?.reused ? 'reused' : 'new'})  dcw=${r.line?.dcw} daq=${r.line?.daq}`,
      `outcome: writes=${r.mission?.writes} attained=${r.mission?.attained} wall=${r.wallS}s`,
      ``,
      '== ensure ==', JSON.stringify(r.ensure), JSON.stringify(r.verified),
      ``,
      '== trajectory ==',
      ...(r.mission?.traj ?? []).map((t) => JSON.stringify(t)),
      ``,
      '== log ==',
      ...(r.mission?.ev ?? []),
    ]
    wt(`${outDir}/scenarios-mission-${r.id}.log`, lines.join('\n') + '\n')
  }
}
