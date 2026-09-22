#!/usr/bin/env node
/**
 * bench/scenarios.mjs —— 多场景并行闭环基准(独立入口,2026-09)。
 *
 * 在 PLC 模拟器的多个默认工业场景上,同时各建一条产线、各开一个 AgentTeam Channel,
 * 三路并行做「读数 → 受治理下发 → 物理随动 → 判定收口」的闭环优化,并把优化过程与
 * 结果完整落盘为标准 benchmark MD + HTML 可视化报告:
 *
 *   bench/results/<runId>/scenarios-benchmark.md / scenarios-benchmark.html
 *   bench/results/<runId>/scenarios.json / scenarios-mission-<id>.log
 *
 * 场景(详见 PIPELINE.md §10 场景目录):
 *   injection  注塑成型 —— 克重窗口寻优(保压/保压时间/模温,飞边-缩痕权衡)
 *   wwtp       A2O 污水处理 —— 排放达标 + 药耗/气耗最小化
 *   anneal     连续退火 —— 硬度/抗拉质量窗 + 线速产能最大化
 *
 * 幂等:模拟器侧差分 ensure(已接入零改动);平台侧产线按标签复用(不重复建线)。
 *
 * 用法(与集成流水线同一隔离环境块):
 *   node bench/scenarios.mjs --seed 42
 *   node bench/scenarios.mjs --scenarios injection,wwtp,anneal --tool-harness opencode
 *   node bench/scenarios.mjs --no-autostart      # 只复用在线服务
 * 退出码:0 = 全场景达标;1 = 存在错误或未达标。
 */
import { join, dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeApi, sha256, ensureDir, runId as mkRunId, sleep } from './lib/util.mjs'
import { ensureSimulator, simUp, SIM_BASE } from './lib/sim.mjs'
import { ensurePlatform } from './lib/platform.mjs'
import { SCENARIOS, SCENARIO_IDS, runScenarioBench } from './lib/scenarios.mjs'
import { writeScenarioReports } from './lib/scenario-report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const seed = Number(arg('seed', 42))
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const toolHarness = arg('tool-harness', process.env.AW_TOOL_HARNESS ?? 'opencode')
const autostart = !has('no-autostart')
const noAutostartPlat = has('no-autostart-platform')
const fresh = !has('no-fresh') // mission 起点复位到蓝图次优工况(接入/产线仍幂等复用)
const scenarios = (arg('scenarios', '') || process.env.AW_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean)
const list = scenarios.length ? scenarios.filter(id => SCENARIOS[id]) : SCENARIO_IDS

const HARNESS_FILES = ['scenarios.mjs', 'lib/scenarios.mjs', 'lib/scenario-report.mjs', 'lib/sim.mjs', 'lib/platform.mjs']
const harnessHash = sha256(HARNESS_FILES.map(f => {
  try { return readFileSync(join(HERE, f), 'utf8') } catch { return `MISSING:${f}` }
}).join('\n%%\n'))
let gitCommit = 'unknown'
try { gitCommit = (await import('node:child_process')).execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* 非 git 容错 */ }

const rid = mkRunId()
const outDir = ensureDir(join(REPO, 'bench', 'results', rid))
const api = makeApi(base)

console.log(`\n=== AW-IndustrialBench · multi-scenario parallel closed-loop ${rid} ===`)
console.log(`scenarios=${list.join(',')}  seed=${seed}  toolHarness=${toolHarness}`)
console.log(`platform=${base}  simulator=${SIM_BASE}\n`)

// ── P0 自举(与 pipeline 同一自举路径:模拟器 + 平台 + 鉴权)──
if (!(await simUp())) {
  if (!autostart) { console.error(`✘ simulator ${SIM_BASE} 不可达且 --no-autostart`); process.exit(1) }
  const r = await ensureSimulator({ log: console.log })
  if (!r.started && !(await simUp())) { console.error(`✘ 模拟器自举失败: ${r.reason}`); process.exit(1) }
}
if (!noAutostartPlat) {
  const pr = await ensurePlatform({ base, log: console.log })
  if (!pr.started && pr.reason && pr.reason !== 'already-up') { console.error(`✘ 平台自举失败: ${pr.reason}`); process.exit(1) }
}
let login = { ok: false, how: 'unreachable' }
try { login = await api.login(process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', process.env.AW_ADMIN_PASS ?? 'admin123') }
catch (e) { login = { ok: false, how: String(e?.message ?? e).slice(0, 80) } }
if (!login.ok) { console.error(`✘ 平台鉴权失败(${login.how})`); process.exit(1) }
console.log(`✔ 平台就绪并鉴权(${login.how})\n`)

// ── 预热:三场景执行器节点先确保(差分 ensure 内部有 OPC UA boot 等待,串行做一次)──
for (const id of list) {
  console.log(`· 预检场景 ${id}(${SCENARIOS[id].zh})`)
}

// ── 三场景并行:ensure → 建线 → channel → mission(全轨迹)──
const t0 = Date.now()
const bench = await runScenarioBench(api, {
  scenarios: list, sfx: `ms${seed.toString(36)}${Date.now().toString(36).slice(-4)}`,
  toolHarness, fresh,
  onLog: (m) => console.log(`  ${m}`),
})
const wallS = Number(((Date.now() - t0) / 1000).toFixed(1))

const run = {
  runId: rid, at: new Date().toISOString(), seed, base, simBase: SIM_BASE,
  toolHarness, gitCommit, harnessHash, wallS,
  scenarios: list,
  results: bench.results.map((r) => ({ ...r, pv: SCENARIOS[r.id]?.pv })),
  ok: bench.ok && bench.results.every(r => !r.errors.length && r.mission?.attained),
}
writeScenarioReports(outDir, run)

console.log(`\n=== 结果 ===`)
for (const r of run.results) {
  const m = r.mission ?? {}
  console.log(`  ${r.mission?.attained && !r.errors.length ? '✔' : '✘'} ${r.id.padEnd(10)} ${r.zh.padEnd(14)} writes=${String(m.writes ?? '—').padEnd(3)} rounds=${String(m.rounds ?? '—').padEnd(3)} wall=${r.wallS}s${r.line?.reused ? ' · 线复用' : ''}${r.errors.length ? ` · errors: ${r.errors[0]}` : ''}`)
}
console.log(`  并行 wall = ${wallS}s(串行累计 ${run.results.reduce((s, r) => s + (r.wallS ?? 0), 0)}s)`)
console.log(`  报告 → bench/results/${rid}/scenarios-benchmark.md + .html`)
process.exit(run.ok ? 0 : 1)
