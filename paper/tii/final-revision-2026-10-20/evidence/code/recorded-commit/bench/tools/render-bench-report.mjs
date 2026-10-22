#!/usr/bin/env node
/**
 * bench/tools/render-bench-report.mjs —— 用报告模板(bench/lib/report-template.mjs)对既有
 * pipeline 运行目录重渲 report.md + report.html（无需重跑管线）。
 *
 * 用途：
 *   1. 模板迭代后的重发布（run.json 是单一事实源，报告 100% 由它重建）；
 *   2. 论文/对外交付时对历史 runId 出报告。
 * 用法：node bench/tools/render-bench-report.mjs <runDir|runId>   （缺省 = 最新一个运行目录）
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeText, writeJson } from '../lib/util.mjs'
import { barChart } from '../lib/dashboard.mjs'
import { renderBenchmarkHtml, renderBenchmarkMd, collectArtifacts } from '../lib/report-template.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const resultsDir = join(REPO, 'bench', 'results')

function resolveRunDir(ref) {
  const direct = resolve(process.cwd(), ref)
  if (existsSync(direct) && statSync(direct).isDirectory() && existsSync(join(direct, 'run.json'))) return direct
  const hit = join(resultsDir, ref)
  if (existsSync(join(hit, 'run.json'))) return hit
  const dirs = readdirSync(resultsDir).filter((s) => existsSync(join(resultsDir, s, 'run.json'))).sort()
  if (!ref && dirs.length) return join(resultsDir, dirs[dirs.length - 1])
  throw new Error(`运行目录未找到: ${ref}（可用: ${dirs.slice(-5).join(', ')}…）`)
}

const outDir = resolveRunDir(process.argv[2])
const run = JSON.parse((await import('node:fs')).readFileSync(join(outDir, 'run.json'), 'utf8'))
const { env, phases, checks, kpis, metrics, lines = [], closedloop } = run
// 12 格平衡:KPI 总数非 6 的倍数时补一格 verdict 汇总（与 pipeline 收尾同语义）
if ((kpis?.length ?? 0) % 6 !== 0) {
  const v = env.verdict ?? {}
  kpis.push({ label: 'Verdict', value: v.ok ? 'PASS' : 'FAIL', unit: '', note: `${v.pass ?? 0}/${(v.pass ?? 0) + (v.warn ?? 0) + (v.fail ?? 0)} checks · hard gate ${v.ok ? 'green' : 'tripped'}` })
}
if (!env?.reproCmd?.includes('pipeline')) {
  console.error('注意: 该 run.json 不是 pipeline 产物（run.mjs 层的报告模板不同），仍按 pipeline 模板渲染。')
}

// 图表重建（与 pipeline.mjs 收尾同一组面板/同一印刷色板）
const r3 = (v) => Number(Number(v).toFixed(3))
const charts = [
  lines.filter((l) => l.writeP50 != null).length
    ? barChart({ title: 'Write p50 (ms, per line/protocol)', unit: 'ms', color: '#1f6f8b', rows: lines.filter((l) => l.writeP50 != null).map((l) => ({ label: `L${l.index} ${l.protocol}`, value: l.writeP50 })) })
    : '',
  lines.some((l) => l.daqSamples)
    ? barChart({ title: 'DAQ sample points (real driver)', unit: '', color: '#0a7d54', rows: lines.map((l) => ({ label: `L${l.index} ${l.protocol}`, value: l.daqSamples ?? 0 })) })
    : '',
  lines.filter((l) => l.f5Total != null).length
    ? barChart({ title: 'Governance F5 interception (%)', unit: '%', color: '#8a5a00', max: 100, rows: lines.filter((l) => l.f5Total != null).map((l) => ({ label: `L${l.index} ${l.protocol}`, value: r3((l.f5Rejected / l.f5Total) * 100) })) })
    : '',
  lines.filter((l) => l.convergenceS != null).length
    ? barChart({ title: 'Agent loop convergence (s)', unit: 's', color: '#b0553a', rows: lines.filter((l) => l.convergenceS != null).map((l) => ({ label: `L${l.index} ${l.protocol}`, value: l.convergenceS })) })
    : '',
  closedloop?.agg
    ? barChart({
        title: `Closed-loop J (per seed): start → end vs offline optimum J*=${closedloop.agg.Jstar}`,
        unit: '', color: '#1f6f8b', max: Math.max(closedloop.agg.Jstar ?? 100, closedloop.agg.J0mean ?? 100) * 1.12,
        rows: [
          ...closedloop.seeds.flatMap((s) => ([
            { label: `S${s.seed} start`, value: s.J0, color: '#9aa5ad' },
            { label: `S${s.seed} end`, value: s.Jend, color: (s.ratio ?? 0) >= 0.9 ? '#0a7d54' : '#8a5a00' },
          ])),
          { label: 'J* (offline optimum)', value: closedloop.agg.Jstar, color: '#b0553a' },
        ],
      })
    : '',
  closedloop?.agg
    ? barChart({ title: 'Closed-loop attainment J/J* (%)', unit: '%', color: '#0a7d54', max: 100, rows: closedloop.seeds.filter((s) => s.ratio != null).map((s) => ({ label: `seed ${s.seed}`, value: r3(s.ratio * 100), color: (s.ratio ?? 0) >= 0.9 ? '#0a7d54' : '#8a5a00' })) })
    : '',
  closedloop?.agg
    ? barChart({ title: 'Closed-loop iterations (count)', unit: '', color: '#1f6f8b', rows: closedloop.seeds.map((s) => ({ label: `seed ${s.seed}`, value: s.iters ?? s.stats?.iters })) })
    : '',
].filter(Boolean).join('')

const artifacts = collectArtifacts(outDir, [
  'agentteam-mission.log', 'agentteam-biax.log',
  'agent-loop-omp.log', 'agent-loop-opencode.log', 'agent-loop-codex.log',
  'agent-goal-loop-omp.log', 'agent-goal-loop-opencode.log', 'agent-goal-loop-codex.log',
  'metrics.csv', 'run.json', 'summary.json',
])
const ctx = {
  env, phases, checks, kpis, metrics,
  closedloop: closedloop?.agg ? { writeMode: closedloop.writeMode, agg: closedloop.agg, seeds: closedloop.seeds } : null,
  charts, artifacts,
  // 产线画像与 AgentTeam 闭环专章数据(随 run.json 归档;缺失时模板按无数据渲染)
  lineProfile: run.lineProfile ?? null,
  agentteam: run.agentteam ?? null,
}
writeText(join(outDir, 'report.md'), renderBenchmarkMd(ctx))
writeText(join(outDir, 'report.html'), renderBenchmarkHtml(ctx))
writeJson(join(outDir, 'render-manifest.json'), { renderedAt: new Date().toISOString(), template: 'bench/lib/report-template.mjs', runId: env.runId, artifacts })
console.log(`re-rendered: ${outDir}`)
console.log(`  report.md / report.html ← run.json (template v1, direction-notes: bench/lib/direction-notes.md)`)
