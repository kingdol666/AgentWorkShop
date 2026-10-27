#!/usr/bin/env node
/**
 * analyze-repeat —— 重复实验统计分析(论文表生成)
 * 输入:bench/results/repeat-<tag>/traj-*.json(+experiment.json)
 * 输出:分场景三臂统计(终末|err| 原生单位)、配对 Δ(B0−T / B1−T)均值±SD+95%CI+t 检验 p、
 *       入窗率、入窗时间、写次数、功效分析(基于先导/全样本方差)。
 * 用法:node bench/analyze-repeat.mjs --tag full [--seeds 42,43,44,45,46,47,48]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const tag = arg('tag', 'full')
const DIR = join(process.cwd(), 'bench', 'results', `repeat-${tag}`)

// t 分布 0.975 分位数(小样本,n=2..10;足够本实验精度)
const T975 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 }

const mean = a => a.reduce((x, y) => x + y, 0) / a.length
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) }
/** 配对 Welch/BF? 用配对 t:Δi = x_i − y_i;p 由 t 统计量近似(双侧) */
function pairedT(diffs) {
  const n = diffs.length
  const m = mean(diffs), s = sd(diffs)
  const t = s > 0 ? m / (s / Math.sqrt(n)) : (m === 0 ? 0 : Infinity)
  // 双侧 p:正态近似 + t 分布查表的保守下界;此处给 p<0.001 / <0.01 / <0.05 / n.s. 分级
  const level = Math.abs(t) > 4 ? 'p<0.001' : Math.abs(t) > 3 ? 'p<0.01' : Math.abs(t) > 2.447 ? 'p<0.05' : 'n.s.(α=0.05)'
  return { n, mean: m, sd: s, t, level }
}

const files = readdirSync(DIR).filter(f => f.startsWith('traj-') && f.endsWith('.json'))
const per = {} // scenario → {unit, target, tol, arms: {B0:[], B1:[], T:[]}, excluded:[] }
for (const f of files) {
  const d = JSON.parse(readFileSync(join(DIR, f), 'utf8'))
  const key = d.scenario
  per[key] ??= { unit: d.unit, target: d.target, tol: d.tol, pv: d.pvSignal, arms: { B0: [], B1: [], T: [] }, excluded: [] }
  const bucket = d.t?.excluded ? per[key].excluded : per[key].arms
  const rec = { seed: d.seed, finalErr: d.t.finalErr, inWindow: d.t.inWindow, writes: d.t.writes, timeToWindowS: d.t.timeToWindowS ?? null, series: d.t.series }
  if (d.t.excluded) per[key].excluded.push({ seed: d.seed, errors: d.t.errors })
  else bucket.T.push(rec)
  bucket.B0.push({ seed: d.seed, finalErr: d.b0.finalErr, inWindow: d.b0.inWindow, writes: 0, series: d.b0.series })
  bucket.B1.push({ seed: d.seed, finalErr: d.b1.finalErr, inWindow: d.b1.inWindow, writes: d.b1.writes, series: d.b1.series })
}

const lines = []
lines.push(`# 重复实验统计 · tag=${tag}`)
lines.push('')
lines.push(`> 主终点:各臂结束时的 |PV−target|(场景原生单位;分场景报告)。配对设计:同 seed 同初始状态。`)
lines.push('')
const summary = {}
for (const [sid, P] of Object.entries(per)) {
  const stat = arm => {
    const errs = P.arms[arm].map(x => x.finalErr).filter(Number.isFinite)
    return { n: errs.length, mean: errs.length ? mean(errs) : null, sd: errs.length > 1 ? sd(errs) : null, inWindow: P.arms[arm].filter(x => x.inWindow).length, writes: mean(P.arms[arm].map(x => x.writes ?? 0)) }
  }
  const B0 = stat('B0'), B1 = stat('B1'), T = stat('T')
  const seedsList = P.arms.T.map(x => x.seed)
  const pair = other => {
    const diffs = P.arms.T.filter(x => Number.isFinite(x.finalErr)).map(x => {
      const o = P.arms[other].find(y => y.seed === x.seed)
      return o && Number.isFinite(o.finalErr) ? o.finalErr - x.finalErr : null
    }).filter(Number.isFinite)
    return diffs.length > 1 ? pairedT(diffs) : { n: diffs.length, mean: diffs[0] ?? null, sd: null, level: 'n/a' }
  }
  const d0 = pair('B0'), d1 = pair('B1')
  const ci = (p) => p.sd != null && p.n >= 2 ? [p.mean - T975[Math.min(p.n, 10)] * p.sd / Math.sqrt(p.n), p.mean + T975[Math.min(p.n, 10)] * p.sd / Math.sqrt(p.n)] : null
  const ci0 = ci(d0), ci1 = ci(d1)
  lines.push(`## ${sid}(PV=${P.pv},目标 ${P.target}±${P.tol} ${P.unit})`)
  lines.push('')
  lines.push(`| 臂 | n | 终末|err|均值±SD(${P.unit}) | 95%CI | 入窗率 | 平均写次数 |`)
  lines.push(`| --- | --- | --- | --- | --- | --- |`)
  lines.push(`| B0 开环 | ${B0.n} | ${B0.mean?.toFixed(3)} ± ${B0.sd?.toFixed(3) ?? 'n/a'} | - | ${B0.inWindow}/${B0.n} | 0 |`)
  lines.push(`| B1 一步式 | ${B1.n} | ${B1.mean?.toFixed(3)} ± ${B1.sd?.toFixed(3) ?? 'n/a'} | - | ${B1.inWindow}/${B1.n} | ${B1.writes?.toFixed(1)} |`)
  lines.push(`| T 闭环迭代 | ${T.n} | ${T.mean?.toFixed(3)} ± ${T.sd?.toFixed(3) ?? 'n/a'} | - | ${T.inWindow}/${T.n} | ${T.writes?.toFixed(1)} |`)
  lines.push('')
  lines.push(`- 配对 Δ(B0−T)=${d0.mean?.toFixed(3)} ${P.unit}(95%CI ${ci0 ? ci0.map(x => x.toFixed(3)).join(' ~ ') : 'n/a'},SD=${d0.sd?.toFixed(3) ?? 'n/a'},${d0.level},n=${d0.n})`)
  lines.push(`- 配对 Δ(B1−T)=${d1.mean?.toFixed(3)} ${P.unit}(95%CI ${ci1 ? ci1.map(x => x.toFixed(3)).join(' ~ ') : 'n/a'},SD=${d1.sd?.toFixed(3) ?? 'n/a'},${d1.level},n=${d1.n})`)
  const t2w = P.arms.T.map(x => x.timeToWindowS).filter(Number.isFinite)
  if (t2w.length) lines.push(`- T 入窗时间:${t2w.map(x => x.toFixed(1)).join('/')} s(均值 ${mean(t2w).toFixed(1)}s)`)
  if (P.excluded.length) lines.push(`- **排除轨迹**:${P.excluded.map(x => `seed=${x.seed}(${x.errors.join(';').slice(0, 80)})`).join(' ; ')}`)
  else lines.push(`- 排除轨迹:无`)
  // 功效分析:以本样本 SD 估计,检测观测效应所需 n(α=0.05, power=0.8 → n ≈ ((1.96+0.84)σ/δ)²)
  const eff = d0.mean
  const s0 = d0.sd
  const nReq = eff > 0 && s0 > 0 ? Math.ceil(((1.96 + 0.84) * s0 / eff) ** 2) : (eff > 0 ? 2 : null)
  lines.push(`- 功效分析:δ(B0−T)=${eff?.toFixed(3)},σ=${s0?.toFixed(3) ?? 'n/a'} → α=0.05/power=0.8 所需 n≈${nReq ?? 'n/a'}(本次 n=${d0.n})`)
  lines.push('')
  summary[sid] = { B0, B1, T, d0: { ...d0, ci: ci0 }, d1: { ...d1, ci: ci1 }, excluded: P.excluded.length, unit: P.unit }
}
writeFileSync(join(DIR, 'stats.json'), JSON.stringify(summary, null, 2))
const outMd = join(DIR, 'stats.md')
writeFileSync(outMd, lines.join('\n'))
console.log(lines.join('\n'))
console.log(`\n→ ${outMd}`)
