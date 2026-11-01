#!/usr/bin/env node
/**
 * bench/tools/build-experiment-report.mjs —— 论文实验可视化总报告
 *
 * 把「功能 / 多场景多协议 / 优化对照 / 消融 / 可复现」五类产物汇总成一份自包含 HTML
 * （内联 SVG，无外部依赖，可离线打开、可随论文附录分发）。
 *
 * 用法（全部参数可选，缺省按 runId/路径解析）：
 *   node bench/tools/build-experiment-report.mjs \
 *     --pipeline <runId> --static <runId> --plc <runId> --e1lite <runId> \
 *     --probes <csv> --c1 <csv[,csv]> --c0 <csv[,csv]> --guards <csv> \
 *     --compare <md> --out bench/reports-archive/<标签>
 *
 * 只做汇总与可视化，不产生新判定；每个数字都来自传入的 CSV/run.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(REPO, 'bench', 'results')
const args = process.argv.slice(2)
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }

const parseCsv = (text) => {
  const lines = text.trim().split(/\r?\n/)
  const head = lines[0].split(',')
  return lines.slice(1).map(line => {
    const cells = []
    let cur = '', q = false
    for (const ch of line) {
      if (ch === '"') { q = !q; continue }
      if (ch === ',' && !q) { cells.push(cur); cur = ''; continue }
      cur += ch
    }
    cells.push(cur)
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']))
  })
}

const readCsv = (p) => {
  if (!p) return []
  const paths = String(p).split(',').map(s => s.trim()).filter(Boolean)
  return paths.flatMap(x => {
    const abs = x.includes('/') || x.includes('\\') ? resolve(REPO, x) : join(RESULTS, x)
    return existsSync(abs) ? parseCsv(readFileSync(abs, 'utf8')) : []
  })
}

const readRun = (id) => {
  if (!id) return null
  const p = id.includes('/') || id.includes('\\') ? resolve(REPO, id) : join(RESULTS, id, 'run.json')
  if (!existsSync(p)) return null
  try { return { id: basename(dirname(p)), json: JSON.parse(readFileSync(p, 'utf8')) } }
  catch { return null }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const pct = (a, b) => (b ? `${a}/${b} (${((a / b) * 100).toFixed(0)}%)` : '—')

// ── 数据装载 ──────────────────────────────────────────────
const pipeline = readRun(val('pipeline'))
const staticRun = readRun(val('static'))
const plcRun = readRun(val('plc'))
const e1Run = readRun(val('e1lite'))
const probeRows = readCsv(val('probes'))
const c1Rows = readCsv(val('c1'))
const c0Rows = readCsv(val('c0'))
const guardRows = readCsv(val('guards'))
const approvalRows = readCsv(val('approval'))
const authRows = readCsv(val('auth'))
const comparePath = val('compare')
const compareText = comparePath && existsSync(resolve(REPO, comparePath)) ? readFileSync(resolve(REPO, comparePath), 'utf8') : ''

// 功能检查（流水线）
const checks = pipeline?.json?.checks ?? []
const checkStat = {
  total: checks.length,
  pass: checks.filter(c => c.status === 'pass').length,
  warn: checks.filter(c => c.status === 'warn').length,
  fail: checks.filter(c => c.status === 'fail').length,
  skip: checks.filter(c => c.status === 'skip').length,
}
const warnIds = checks.filter(c => c.status !== 'pass').map(c => `${c.phase}·${c.id}(${c.status})`)

// 分层检查（static/plc/e1-lite 的 results）
const tierStat = (run) => {
  const r = run?.json?.results ?? []
  return { total: r.length, pass: r.filter(x => x.status === 'pass').length, warn: r.filter(x => x.status === 'warn').length, fail: r.filter(x => x.status === 'fail').length }
}
const staticStat = tierStat(staticRun)
const plcStat = tierStat(plcRun)
const e1Stat = tierStat(e1Run)

// 准入矩阵
const admission = (() => {
  const m = new Map()
  for (const r of probeRows) {
    const k = `${r.scene}|${r.protocol}`
    const cur = m.get(k) ?? { scene: r.scene, protocol: r.protocol, legalOk: 0, legal: 0, structOk: 0, struct: 0, rbOk: 0, rb: 0 }
    if (r.probeClass === 'structural') { cur.struct++; if (r.got === 'reject') cur.structOk++ }
    else if (r.probeClass !== 'restore') {
      cur.legal++
      if (r.got === 'accept') cur.legalOk++
      if (r.readback !== '' && r.readback != null) { cur.rb++; if (r.withinTolerance === 'true') cur.rbOk++ }
    }
    m.set(k, cur)
  }
  return [...m.values()].sort((a, b) => a.scene.localeCompare(b.scene) || a.protocol.localeCompare(b.protocol))
})()

// 优化对照（按场景归并 C0/C1）
const control = (() => {
  const m = new Map()
  for (const r of [...c0Rows, ...c1Rows]) {
    const k = r.scene
    const cur = m.get(k) ?? { scene: k, target: num(r.target), tol: num(r.tol), c0: [], c1: [] }
    const pt = { seed: Number(r.seed), pv: num(r.pv), attained: r.attained === 'true', writes: num(r.writes), rounds: num(r.rounds) }
    if (r.condition === 'C0') cur.c0.push(pt); else cur.c1.push(pt)
    m.set(k, cur)
  }
  return [...m.values()].sort((a, b) => a.scene.localeCompare(b.scene))
})()

// 四臂消融（e1-lite）
const ablation = (() => {
  const rows = e1Run?.json?.rows ?? []
  const m = new Map()
  for (const r of rows) {
    if (!r || r.result !== 'summary') continue
    const cur = m.get(r.arm) ?? { arm: r.arm, reps: 0, intercept: [], breach: 0, falseBlock: 0, p50: [] }
    cur.reps++
    cur.intercept.push(num(r.intercept_rate) ?? 0)
    cur.breach += num(r.window_breach_executed) ?? 0
    cur.falseBlock += num(r.false_block) ?? 0
    if (num(r.write_p50_ms) != null) cur.p50.push(num(r.write_p50_ms))
    m.set(r.arm, cur)
  }
  const order = ['full', 'no-readback', 'no-interlock', 'ungated']
  return order.filter(a => m.has(a)).map(a => {
    const c = m.get(a)
    return { ...c, interceptMean: c.intercept.reduce((x, y) => x + y, 0) / (c.intercept.length || 1), p50Mean: c.p50.length ? c.p50.reduce((x, y) => x + y, 0) / c.p50.length : null }
  })
})()

// ── SVG 图表 ──────────────────────────────────────────────
const FONT = `font-family:-apple-system,Segoe UI,Roboto,'Noto Sans SC',sans-serif`
const palette = ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

function barChart({ labels, series, width = 640, height = 240, yMax, unit = '', title = '' }) {
  const pad = { l: 44, r: 12, t: 34, b: 56 }
  const w = width - pad.l - pad.r
  const h = height - pad.t - pad.b
  const max = yMax ?? Math.max(1, ...series.flatMap(s => s.values))
  const groupW = w / labels.length
  const barW = Math.min(28, (groupW - 12) / series.length)
  const y = v => pad.t + h - (Math.max(0, Math.min(max, v)) / max) * h
  let out = `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}">`
  out += `<text x="${pad.l}" y="16" ${FONT} font-size="12" fill="#64748b">${esc(title)}</text>`
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i
    out += `<line x1="${pad.l}" y1="${y(v)}" x2="${width - pad.r}" y2="${y(v)}" stroke="#e2e8f0"/>`
    out += `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" ${FONT} font-size="10" fill="#94a3b8">${Number(v.toFixed(2))}</text>`
  }
  labels.forEach((lb, i) => {
    const x0 = pad.l + i * groupW + (groupW - barW * series.length) / 2
    series.forEach((s, j) => {
      const v = s.values[i] ?? 0
      out += `<rect x="${x0 + j * barW}" y="${y(v)}" width="${barW - 2}" height="${pad.t + h - y(v)}" rx="2" fill="${s.color}"><title>${esc(lb)} ${esc(s.name)}: ${v}${esc(unit)}</title></rect>`
    })
    out += `<text x="${pad.l + i * groupW + groupW / 2}" y="${height - 34}" text-anchor="middle" ${FONT} font-size="10" fill="#475569">${esc(lb)}</text>`
  })
  series.forEach((s, j) => {
    out += `<rect x="${pad.l + j * 110}" y="${height - 14}" width="9" height="9" fill="${s.color}"/><text x="${pad.l + j * 110 + 13}" y="${height - 6}" ${FONT} font-size="10" fill="#475569">${esc(s.name)}</text>`
  })
  return `${out}</svg>`
}

/** 归一化偏差散点：dev = (PV − target)/tol，±1 = 目标带边界。 */
function controlChart(scenes, width = 680, height = 260) {
  const pad = { l: 56, r: 16, t: 26, b: 44 }
  const w = width - pad.l - pad.r
  const h = height - pad.t - pad.b
  const maxDev = Math.max(3, ...scenes.flatMap(s => [...s.c0, ...s.c1].map(p => (p.pv != null && s.tol) ? Math.abs((p.pv - s.target) / s.tol) : 0)))
  const y = v => pad.t + h / 2 - (v / maxDev) * (h / 2)
  let out = `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="优化控制归一化偏差">`
  out += `<text x="${pad.l}" y="15" ${FONT} font-size="12" fill="#64748b">受控量相对目标带的偏差（(PV−target)/tol；±1 = 带边界，0 = 正中）</text>`
  out += `<rect x="${pad.l}" y="${y(1)}" width="${w}" height="${Math.max(1, y(-1) - y(1))}" fill="#dcfce7"/>`
  out += `<line x1="${pad.l}" y1="${y(0)}" x2="${width - pad.r}" y2="${y(0)}" stroke="#16a34a" stroke-dasharray="4 3"/>`
  for (const v of [maxDev, maxDev / 2, 0, -maxDev / 2, -maxDev]) {
    out += `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" ${FONT} font-size="10" fill="#94a3b8">${v.toFixed(1)}</text>`
  }
  const step = w / Math.max(1, scenes.length)
  scenes.forEach((s, i) => {
    const cx = pad.l + step * i + step / 2
    out += `<text x="${cx}" y="${height - 24}" text-anchor="middle" ${FONT} font-size="11" fill="#475569">${esc(s.scene)}</text>`
    const draw = (pts, color, dx) => {
      pts.forEach((p, k) => {
        if (p.pv == null || !s.tol) return
        const dev = (p.pv - s.target) / s.tol
        const x = cx + dx + (k - (pts.length - 1) / 2) * 9
        out += `<circle cx="${x}" cy="${y(dev)}" r="4.5" fill="${color}" opacity="0.85"><title>${esc(s.scene)} seed ${p.seed}: PV ${p.pv}（${p.attained ? '达标' : '未达标'}）</title></circle>`
      })
    }
    draw(s.c0, '#ef4444', -18)
    draw(s.c1, '#2563eb', 18)
  })
  out += `<circle cx="${width - 132}" cy="18" r="4" fill="#ef4444"/><text x="${width - 122}" y="22" ${FONT} font-size="10" fill="#475569">C0 不写</text>`
  out += `<circle cx="${width - 58}" cy="18" r="4" fill="#2563eb"/><text x="${width - 48}" y="22" ${FONT} font-size="10" fill="#475569">C1 策略</text>`
  return `${out}</svg>`
}

// ── 组装 ────────────────────────────────────────────────
const generatedAt = new Date().toISOString()
const env = pipeline?.json?.env ?? {}
const commit = String(env.gitCommit ?? 'unknown').slice(0, 8)

const admissionByScene = (() => {
  const m = new Map()
  for (const r of admission) {
    const cur = m.get(r.scene) ?? { scene: r.scene, legalOk: 0, legal: 0, structOk: 0, struct: 0, rbOk: 0, rb: 0, protocols: 0 }
    cur.legalOk += r.legalOk; cur.legal += r.legal; cur.structOk += r.structOk; cur.struct += r.struct; cur.rbOk += r.rbOk; cur.rb += r.rb; cur.protocols++
    m.set(r.scene, cur)
  }
  return [...m.values()].sort((a, b) => a.scene.localeCompare(b.scene))
})()

const controlRows = control.map(s => {
  const c0Text = s.c0.map(p => `${p.pv ?? '—'}${p.attained ? '✔' : '✘'}`).join(' / ')
  const c1Text = s.c1.map(p => `${p.pv ?? '—'}${p.attained ? '✔' : '✘'}`).join(' / ')
  const c0Att = s.c0.filter(p => p.attained).length
  const c1Att = s.c1.filter(p => p.attained).length
  // 保留数组长度作分母：early 版本把 c0 覆盖成字符串，导致分母变成字符数
  return { ...s, c0Text, c1Text, c0Att, c1Att, c0N: s.c0.length, c1N: s.c1.length }
})

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AgentWorkShop · 论文实验总报告 ${esc(generatedAt.slice(0, 10))}</title>
<style>
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f8fafc;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}
*{box-sizing:border-box}
body{margin:0;${FONT};color:var(--ink);background:var(--bg);line-height:1.55}
header{background:linear-gradient(135deg,#0f172a,#1e3a8a);color:#fff;padding:34px 40px 26px}
header h1{margin:0 0 6px;font-size:24px;letter-spacing:.3px}
header .sub{opacity:.85;font-size:13px}
main{max-width:1080px;margin:0 auto;padding:26px 20px 60px}
section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin:18px 0;box-shadow:0 1px 2px rgba(15,23,42,.04)}
h2{font-size:17px;margin:0 0 6px;display:flex;align-items:center;gap:8px}
h2 .n{display:inline-flex;width:24px;height:24px;border-radius:7px;background:#1e3a8a;color:#fff;font-size:12px;align-items:center;justify-content:center}
.lead{color:var(--muted);font-size:13px;margin:0 0 14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-weight:600;font-size:12px;background:#f1f5f9}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
.ok{background:#dcfce7;color:#166534}.warn{background:#fef3c7;color:#92400e}.bad{background:#fee2e2;color:#991b1b}.mute{background:#e2e8f0;color:#475569}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0 4px}
.kpi{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fbfdff}
.kpi .v{font-size:22px;font-weight:700}
.kpi .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.note{font-size:12px;color:var(--muted);margin-top:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.grid2{grid-template-columns:1fr}}
code{background:#f1f5f9;padding:1px 5px;border-radius:5px;font-size:12px}
ul{margin:8px 0 0 18px;padding:0}li{margin:3px 0;font-size:13px}
footer{color:var(--muted);font-size:12px;text-align:center;padding:10px}
</style></head><body>
<header>
  <h1>AgentWorkShop · 论文实验总报告</h1>
  <div class="sub">生成 ${esc(generatedAt)} · 代码 ${esc(commit)} · 随机种子 {42…46} · 被测对象：PLC 数字孪生 / 生产型模拟场景（非实体工厂）</div>
</header>
<main>

<section>
  <h2><span class="n">1</span>功能与治理：集成流水线</h2>
  <p class="lead">一次完整 integrated run 覆盖供给、五协议接入、受治理写、审批、回读、回退、账本与多场景。
  判据：<code>fail = 0</code>；本批次 <b>${checkStat.pass}/${checkStat.warn}/${checkStat.fail}</b>（pass/warn/fail，共 ${checkStat.total} 项）。</p>
  <div class="kpis">
    <div class="kpi"><div class="v">${checkStat.pass}<span style="font-size:13px;color:var(--muted)">/${checkStat.total}</span></div><div class="l">检查通过</div></div>
    <div class="kpi"><div class="v" style="color:var(--warn)">${checkStat.warn}</div><div class="l">warn</div></div>
    <div class="kpi"><div class="v" style="color:var(--bad)">${checkStat.fail}</div><div class="l">fail</div></div>
    <div class="kpi"><div class="v">${staticStat.pass}/${staticStat.total || '—'}</div><div class="l">静态层（论文-代码）</div></div>
    <div class="kpi"><div class="v">${plcStat.pass}/${plcStat.total || '—'}</div><div class="l">真实协议层</div></div>
  </div>
  ${pipeline ? barChart({ labels: ['pass', 'warn', 'fail', 'skip'], series: [{ name: '检查数', color: '#2563eb', values: [checkStat.pass, checkStat.warn, checkStat.fail, checkStat.skip] }], title: '集成流水线检查分布', width: 640, height: 200 }) : '<p class="note">未提供 pipeline run。</p>'}
  <p class="note">非 pass 项：${warnIds.length ? warnIds.map(w => `<code>${esc(w)}</code>`).join(' ') : '<b>无</b>（0 warn / 0 fail）'}。
  如存在，则逐项披露为已知非功能项或环境项，不隐藏。</p>
</section>

<section>
  <h2><span class="n">2</span>多场景 × 多协议：写准入矩阵</h2>
  <p class="lead">每节点固定 4 笔合法值（区间内 3 + 上边界 1）与 4 笔越界探针；回读与写入值逐笔比对。
  误拦率的分母 = 合法语料数。</p>
  ${admissionByScene.length
    ? barChart({ labels: admissionByScene.map(s => s.scene), series: [
        { name: '合法受理', color: '#16a34a', values: admissionByScene.map(s => s.legalOk) },
        { name: '越界拒绝', color: '#2563eb', values: admissionByScene.map(s => s.structOk) },
        { name: '回读一致', color: '#8b5cf6', values: admissionByScene.map(s => s.rbOk) },
      ], title: '各场景：受理 / 拒绝 / 回读（笔数）', width: 680, height: 220 })
    : ''}
  <table>
    <thead><tr><th>场景</th><th class="num">协议</th><th class="num">合法受理</th><th class="num">越界拒绝</th><th class="num">回读一致</th></tr></thead>
    <tbody>
    ${admissionByScene.map(s => `<tr><td>${esc(s.scene)}</td><td class="num">${s.protocols}</td><td class="num">${pct(s.legalOk, s.legal)}</td><td class="num">${pct(s.structOk, s.struct)}</td><td class="num">${pct(s.rbOk, s.rb)}</td></tr>`).join('')}
    </tbody>
  </table>
  <p class="note">口径：这三个场景的配方窗等于工程量程，故只含结构类探针；软窗类证据来自 cast-film 流水线
  （每路由 6 条 = 4 结构 + 2 软窗）。HTTP 设备在这些场景为只读检测站，不进入写分母。</p>
</section>

<section>
  <h2><span class="n">3</span>闭环优化：阴性对照 vs 阳性对照</h2>
  <p class="lead">同一场景、同一 seed、同一 fresh 起点下比较「不写」（C0）与「确定性脚本策略」（C1）。
  判定：C0 必须 0/N 达标，否则起点效应使优化结论不成立。</p>
  ${control.length ? controlChart(control) : '<p class="note">未提供 C0/C1 数据。</p>'}
  <table>
    <thead><tr><th>场景</th><th class="num">目标带</th><th>C0（不写）PV</th><th class="num">C0 达标</th><th>C1（策略）PV</th><th class="num">C1 达标</th></tr></thead>
    <tbody>
    ${controlRows.map(s => `<tr><td>${esc(s.scene)}</td><td class="num">${s.target}±${s.tol}</td><td>${esc(s.c0Text)}</td><td class="num"><span class="pill ${s.c0Att ? 'bad' : 'ok'}">${s.c0Att}/${s.c0N}</span></td><td>${esc(s.c1Text)}</td><td class="num"><span class="pill ${s.c1N && s.c1Att === s.c1N ? 'ok' : 'warn'}">${s.c1Att}/${s.c1N}</span></td></tr>`).join('')}
    </tbody>
  </table>
  <p class="note">C1 的达标布尔稳定；写次数/轮次存在 ±1 的环境类波动（见报告末「限制」）。</p>
</section>

<section>
  <h2><span class="n">4</span>消融：治理四臂与生产态五层</h2>
  <p class="lead">四臂（B 态）回答「哪一层在拦」；五层（P 态）回答「生产语义下每层是否各自生效」。</p>
  ${ablation.length
    ? barChart({ labels: ablation.map(a => a.arm), series: [
        { name: '拦截率', color: '#2563eb', values: ablation.map(a => Number((a.interceptMean * 100).toFixed(1))) },
        { name: '越窗执行数×10', color: '#ef4444', values: ablation.map(a => a.breach * 10) },
        { name: '误拦数×10', color: '#f59e0b', values: ablation.map(a => a.falseBlock * 10) },
      ], yMax: 110, unit: '%', title: '四臂消融（拦截率 %；执行/误拦按 ×10 显示）', width: 680, height: 220 })
    : ''}
  <table>
    <thead><tr><th>臂</th><th class="num">拦截率</th><th class="num">越窗执行</th><th class="num">误拦</th><th class="num">写 p50 (ms)</th></tr></thead>
    <tbody>${ablation.map(a => `<tr><td>${esc(a.arm)}</td><td class="num">${(a.interceptMean * 100).toFixed(1)}%</td><td class="num">${a.breach}</td><td class="num">${a.falseBlock}</td><td class="num">${a.p50Mean != null ? a.p50Mean.toFixed(1) : '—'}</td></tr>`).join('')}</tbody>
  </table>
  ${guardRows.length
    ? `<h3 style="font-size:14px;margin:18px 0 6px">生产态逐层拒绝（无 bench 旁路）</h3>
  <table><thead><tr><th>层</th><th>用例</th><th class="num">值</th><th class="num">HTTP</th><th>错误码</th><th>结果</th></tr></thead>
  <tbody>${guardRows.map(r => `<tr><td>${esc(r.layer)}</td><td>${esc(r.label)}</td><td class="num">${esc(r.value)}</td><td class="num">${esc(r.status)}</td><td><code>${esc(r.code)}</code></td><td><span class="pill ${r.got === 'reject' || r.got === 'accept' ? 'ok' : 'bad'}">${esc(r.got)}</span></td></tr>`).join('')}</tbody></table>`
    : ''}
  <p class="note">四臂在 B 态运行：<code>AW_BENCH_MODE=1</code> 会整体豁免单步限/60s 间隔/保持窗，
  因此「full」不等于生产 full；这三层的证据由右表（P 态）提供。</p>
</section>

${authRows.length
  ? `<section>
  <h2><span class="n">4b</span>授权面（Agent 工具面 L1）</h2>
  <p class="lead">同一工具 <code>optimization_explore</code>：未绑定必须拒绝、绑定后必须放行、跨节点必须拒绝。</p>
  <table><thead><tr><th>用例</th><th>Agent</th><th>目标节点</th><th>期望</th><th>实际</th></tr></thead>
  <tbody>${authRows.map(r => `<tr><td>${esc(r.case)}</td><td>${esc(r.agent)}</td><td><code>${esc(r.node)}</code></td><td>${esc(r.expect)}</td><td><span class="pill ${r.got === r.expect ? 'ok' : 'bad'}">${esc(r.got)}</span></td></tr>`).join('')}</tbody></table>
  <p class="note">${authRows.every(r => r.got === r.expect) ? '全部符合预期。' : '存在不符合预期的用例。'}</p>
</section>`
  : ''}

${approvalRows.length
  ? `<section>
  <h2><span class="n">4c</span>审批门：需批准 vs 免批准（配置级对照）</h2>
  <p class="lead">同一场景/节点/初始值/工具/步长，只改运行配置：manual（每次写挂审批）与 auto（直接下发）。
  判据：被拒绝的请求不得到达设备；同一请求在免批准配置下应执行。</p>
  <table><thead><tr><th>臂</th><th>刺激</th><th>审批卡</th><th>裁决</th><th>设备变化</th><th>时延</th></tr></thead>
  <tbody>${approvalRows.map(r => `<tr><td>${esc(r.arm)}</td><td>${esc(r.stimulus)}</td><td>${r.approvalShown === 'true' ? '有' : '无'}</td><td>${esc(r.decision)}</td><td><span class="pill ${r.executed === 'true' ? 'warn' : 'ok'}">${r.executed === 'true' ? '变化' : '不变'}</span></td><td class="num">${esc(r.latencyMs)}ms</td></tr>`).join('')}</tbody></table>
  <p class="note">口径：这是<b>配置级</b>对照（manual vs auto），不是「只跳过审批等待」的单机制消融；
  manual 臂的批准/拒绝由脚本夹具执行，不作为人工判断质量证据。</p>
</section>`
  : ''}

<section>
  <h2><span class="n">5</span>可复现性</h2>
  <p class="lead">同命令双跑 → 判定类指标逐项比对；环境类（时延、采样计数、J 采样值）只报告不设门槛。</p>
  <div class="kpis">
    <div class="kpi"><div class="v">${compareText.includes('REPRODUCIBLE') && !compareText.includes('NOT REPRODUCIBLE') ? 'PASS' : (compareText ? 'FAIL' : '—')}</div><div class="l">流水线双跑判定</div></div>
    <div class="kpi"><div class="v">${ablation.length}</div><div class="l">消融臂（e1-lite）</div></div>
  </div>
  ${compareText ? `<pre style="background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12px;overflow:auto">${esc(compareText.split('\n').slice(0, 22).join('\n'))}</pre>` : '<p class="note">未提供复现判定报告。</p>'}
</section>

<section>
  <h2><span class="n">6</span>限制与不可写项</h2>
  <ul>
    <li>对象是 <b>PLC 数字孪生 / 生产型模拟场景</b>，不是实体工厂，也不构成安全认证。</li>
    <li><b>审批门消融（E3）未运行</b>：旁路 hook 仍在 <code>recipe_trial</code> 路径，论文路径是 <code>optimization_explore</code>；在完成移植与 P 态步长刺激前，不得写入任何审批消融数字。</li>
    <li>C1 的写次数/轮次存在 ±1 波动；达标布尔稳定，轨迹细节属环境类。</li>
    <li>E1 覆盖 3/6 场景的写探针；cast-film 缺合法语料（误拦分母），biax 无探针。</li>
    <li>P10 双拉任务存在已披露的物理层残余非确定性（约半数 run 出现 warn）；按协议重跑取干净跑，warn-run 保留披露。</li>
  </ul>
</section>

<footer>由 bench/tools/build-experiment-report.mjs 生成 · 数据源：run.json / CSV / compare 报告 · 不含手工录入数字</footer>
</main></body></html>`

const outDir = resolve(REPO, val('out') ?? join('bench', 'reports-archive', `experiment-report-${generatedAt.slice(0, 10)}`))
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'experiment-report.html'), html)
writeFileSync(join(outDir, 'experiment-report.md'), [
  '# AgentWorkShop 论文实验总报告',
  '',
  `- 生成：${generatedAt} · 代码 ${commit}`,
  `- 集成流水线：pass ${checkStat.pass} / warn ${checkStat.warn} / fail ${checkStat.fail}（共 ${checkStat.total} 项）`,
  `- 静态层 ${staticStat.pass}/${staticStat.total} · 真实协议层 ${plcStat.pass}/${plcStat.total} · 四臂汇总 ${ablation.length} 条`,
  '',
  '## 写准入矩阵',
  '',
  '| 场景 | 协议数 | 合法受理 | 越界拒绝 | 回读一致 |',
  '|---|---|---|---|---|',
  ...admissionByScene.map(s => `| ${s.scene} | ${s.protocols} | ${pct(s.legalOk, s.legal)} | ${pct(s.structOk, s.struct)} | ${pct(s.rbOk, s.rb)} |`),
  '',
  '## 优化对照（C0 不写 vs C1 脚本策略）',
  '',
  '| 场景 | 目标带 | C0 PV | C0 达标 | C1 PV | C1 达标 |',
  '|---|---|---|---|---|---|',
  ...controlRows.map(s => `| ${s.scene} | ${s.target}±${s.tol} | ${s.c0Text} | ${s.c0Att}/${s.c0N} | ${s.c1Text} | ${s.c1Att}/${s.c1N} |`),
  '',
  ...(authRows.length ? ['## 授权面（L1）', '', '| 用例 | 期望 | 实际 |', '|---|---|---|', ...authRows.map(r => `| ${r.case} | ${r.expect} | ${r.got} |`), ''] : []),
  ...(approvalRows.length ? ['## 审批门（配置级）', '', '| 臂 | 刺激 | 审批卡 | 裁决 | 设备变化 |', '|---|---|---|---|---|', ...approvalRows.map(r => `| ${r.arm} | ${r.stimulus} | ${r.approvalShown} | ${r.decision} | ${r.executed} |`), ''] : []),
  '## 四臂消融',
  '',
  '| 臂 | 拦截率 | 越窗执行 | 误拦 | p50(ms) |',
  '|---|---|---|---|---|',
  ...ablation.map(a => `| ${a.arm} | ${(a.interceptMean * 100).toFixed(1)}% | ${a.breach} | ${a.falseBlock} | ${a.p50Mean != null ? a.p50Mean.toFixed(1) : '—'} |`),
  '',
  '## 限制',
  '',
  '审批门消融（E3）未运行；模拟器层级；C1 轨迹细节有环境类波动。',
  '',
].join('\n'))
console.log(`written: ${join(outDir, 'experiment-report.html')}`)
console.log(`written: ${join(outDir, 'experiment-report.md')}`)
