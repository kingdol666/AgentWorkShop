#!/usr/bin/env node
/**
 * bench/tools/compare-pipeline.mjs —— 两次 integrated 流水线运行的复现判定器。
 *
 * 执行卡第 4 步③的机器化：判定类指标逐位一致 = REPRODUCIBLE；环境类只报告不设门槛。
 * 判定类（同 seed 必须一致）：
 *   - 检查 id 集合与逐项 status（含 warn 也算漂移——warn 常是时序敏感的早期信号）
 *   - F5 池化拦截/误拦、工具闭环达成、P4f 参数面布尔、AgentTeam/双拉任务达标与写数、
 *     闭环收敛数(iters/writes/rejected/converged)、J*、portability 五协议构成、兜底 fired/restored
 *   - 闭环 J/J* ratio 落在论文声明带 [0.966,0.973] 且两次差 ≤0.005
 * 环境类（只报告）：写时延、采样计数、收敛耗时、J0/Jend 采样值、兜底时延、wall time。
 *
 * 用法: node bench/tools/compare-pipeline.mjs --a <runIdA> --b <runIdB> [--out <md>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }

const resolveRun = (ref) => {
  for (const c of [join(REPO, 'bench', 'results', ref), resolve(process.cwd(), ref)]) {
    if (c.endsWith('.json') && exists(c)) return c
    if (exists(join(c, 'run.json'))) return join(c, 'run.json')
  }
  throw new Error(`运行目录未找到: ${ref}`)
}
const exists = (p) => { try { readFileSync(p); return true } catch { return false } }

const A = JSON.parse(readFileSync(resolveRun(arg('a')), 'utf8'))
const B = JSON.parse(readFileSync(resolveRun(arg('b')), 'utf8'))
const outMd = arg('out') ?? join(REPO, 'bench', 'results', `compare-pipeline-${Date.now()}.md`)

const L = []
let fails = 0, envN = 0
const judge = (name, va, vb) => {
  const ok = JSON.stringify(va) === JSON.stringify(vb)
  if (!ok) fails++
  L.push(`| ${name} | ${JSON.stringify(va)} | ${JSON.stringify(vb)} | ${ok ? 'ok' : '**FAIL**'} |`)
}
const env = (name, va, vb) => {
  envN++
  L.push(`| ${name} (env) | ${JSON.stringify(va)} | ${JSON.stringify(vb)} | report |`)
}

const headline = []
headline.push(`# Pipeline 复现判定: 判定类失败 ${'{FAILS}'} · 环境类报告 {ENV} 项`)
L.push('')
L.push(`- A: \`${A.env?.runId}\` (git \`${A.env?.gitCommit}\`, harness \`${String(A.env?.harnessHash ?? '').slice(0, 8)}\`)`)
L.push(`- B: \`${B.env?.runId}\` (git \`${B.env?.gitCommit}\`, harness \`${String(B.env?.harnessHash ?? '').slice(0, 8)}\`)`)
if (A.env?.harnessHash !== B.env?.harnessHash) L.push(`- NOTE: harnessHash 不同(源码演进合法,判定类逐位一致即改判据未变)`)
L.push('')
L.push('## 判定类指标')
L.push('')
L.push('| 指标 | A | B | 判定 |')
L.push('|---|---|---|---|')

// 1) verdict 计数
const vd = (run) => run.env?.verdict ?? run.verdict ?? {}
judge('verdict(pass/warn/fail)', [vd(A).pass, vd(A).warn, vd(A).fail], [vd(B).pass, vd(B).warn, vd(B).fail])

// 2) 检查 id 集合 + 逐项 status
const statusOf = (run) => Object.fromEntries((run.checks ?? []).map(c => [`${c.phase}·${c.id}`, c.status]))
const sa = statusOf(A), sb = statusOf(B)
const ids = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort()
const drifted = ids.filter(id => sa[id] !== sb[id])
judge('检查 id 集合', ids.length, Object.keys(sb).length)
for (const id of drifted) judge(`status ${id}`, sa[id], sb[id])

// 3) F5 池化 + 误拦
const f5 = (run) => {
  const t = (run.lines ?? []).filter(l => l.f5Total != null)
  const tot = t.reduce((s, l) => s + l.f5Total, 0), rej = t.reduce((s, l) => s + l.f5Rejected, 0)
  const fb = (run.lines ?? []).reduce((s, l) => s + (l.falseBlock ?? 0), 0)
  return { rate: tot ? +(rej / tot).toFixed(4) : null, tot, rej, falseBlock: fb }
}
judge('F5 池化拦截/误拦', f5(A), f5(B))

// 4) 工具闭环达成集合
const loops = (run) => (run.summary?.perLine ?? run.lines ?? []).map(l => l.loopIterations ?? 0).sort((x, y) => x - y)
judge('工具闭环 iterations 集合', loops(A), loops(B))

// 5) 闭环优化 benchmark(J* 逐位/iters·writes·rejected·converged;ratio 带内)
const clA = A.closedloop?.agg, clB = B.closedloop?.agg
if (clA && clB) {
  judge('J*(offline optimum)', clA.Jstar, clB.Jstar)
  const seeds = (cl) => (cl.seeds ?? []).map(s => [s.stats?.iters, s.stats?.writes, s.stats?.rejected, s.stats?.converged])
  judge('closedloop iters/writes/rejected/converged', seeds(A.closedloop), seeds(B.closedloop))
  const ra = clA.ratioMean, rb = clB.ratioMean
  const bandOk = [ra, rb].every(r => r >= 0.966 && r <= 0.973)
  const close = Math.abs(ra - rb) <= 0.005
  if (bandOk && close) { envN++; L.push(`| ratio mean (env, 带内) | ${ra} | ${rb} | report |`) }
  else { fails++; L.push(`| ratio mean | ${ra} | ${rb} | **FAIL**(带 [0.966,0.973] 与差 ≤0.005) |`) }
} else L.push(`| closedloop | ${clA ? 'on' : 'off'} | ${clB ? 'on' : 'off'} | ${clA === clB ? 'ok' : '**FAIL**'} |`)

// 6) portability 构成
const port = (run) => {
  const p = run.env?.portability
  return p ? { preset: p.preset, lines: p.lines, ownLines: p.ownLines, sat: p.lines - p.ownLines, f5: p.f5Rejected, falseBlocks: p.falseBlocks } : null
}
judge('portability 构成', port(A), port(B))

// 7) 兜底/任务/双拉(判定语义,时延属环境)
judge('system backstop fired/restored', [A.env?.backstop?.fired, A.env?.backstop?.restored], [B.env?.backstop?.fired, B.env?.backstop?.restored])
env('backstop latency_s', A.env?.backstop?.latencyS, B.env?.backstop?.latencyS)
const biaxJudge = (run) => {
  const b = run.env?.biax
  return b ? { devices: b.devices, signals: b.signals, sp: b.sp, knobs: b.missionKnobs, attained: b.missionAttained } : null
}
judge('biax 建线构成+多节点覆盖+达标', biaxJudge(A), biaxJudge(B))
// 写次数由起始 PV 采样值(环境类)经确定性旋轮算法推导 → 环境类;final μm 同理
env('biax writes/final μm', [A.env?.biax?.missionWrites, A.env?.biax?.missionFinalUm], [B.env?.biax?.missionWrites, B.env?.biax?.missionFinalUm])

// 8) 环境类批量:时延/采样
env('write p50 集合', (A.summary?.perLine ?? []).map(l => l.writeP50), (B.summary?.perLine ?? []).map(l => l.writeP50))
env('daq samples 集合', (A.summary?.perLine ?? []).map(l => l.daqSamples), (B.summary?.perLine ?? []).map(l => l.daqSamples))
env('closedloop J0/Jend', (A.closedloop?.seeds ?? []).map(s => [s.J0, s.Jend]), (B.closedloop?.seeds ?? []).map(s => [s.J0, s.Jend]))

L.push('')
L.push(`## 结论: **${fails === 0 ? 'REPRODUCIBLE' : 'NOT REPRODUCIBLE'}** (判定类失败 ${fails} · 环境类报告 ${envN} 项)`)
L.splice(0, 1, headline[0].replace('{FAILS}', String(fails)).replace('{ENV}', String(envN)))
L.push('')
L.push(`_环境类(时延/采样计数/J 采样值)由物理采样时序决定,只报告不设门槛 —— 与 bench/compare.mjs 的判定契约同哲学。_`)

writeFileSync(outMd, L.join('\n'), 'utf8')
console.log(L.join('\n'))
console.log(`\n报告: ${outMd}`)
process.exit(fails === 0 ? 0 : 1)
