#!/usr/bin/env node
/**
 * bench/run.mjs —— AW-IndustrialBench 可执行入口。
 *
 * 用法：
 *   node bench/run.mjs --tier static                 # 无需服务器：源码清单/论文一致性/治理管线锚点
 *   node bench/run.mjs --tier api --base http://127.0.0.1:3001
 *                 # 需运行中的平台实例：夹具→语义卡→F5 越界写→归因回读→DAQ 新鲜度
 *   node bench/run.mjs --tier full --repeats 3       # static + api×N 轮（判定类指标应逐位一致，
 *                 # 时延类指标按轮聚合），合并报告 + reps 汇总写入 run.json
 *   node bench/run.mjs --only s1,api-3 --seed 7      # 选择性执行
 *
 * 产物（永不覆盖）：bench/results/<runId>/
 *   run.json      机器可读全量结果     report.md   人类可读报告
 *   report.html   可视化评分面板        config-hash.txt
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mulberry32, sha256, ensureDir, writeJson, writeText, runId as mkRunId, makeApi, result as mkResult, skip } from './lib/util.mjs'
import { renderReport } from './lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const TIER_ORDER = { static: 0, api: 1, full: 2, plc: 3 }
const tier = arg('tier', 'static')
const seed = Number(arg('seed', 42))
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const only = has('only') ? String(arg('only', '')).split(',').map(s => s.trim()) : null
const repeats = Math.max(1, Number(arg('repeats', 3)))

const CHECKS = [
  ...(await import('./lib/checks/s1-inventory.mjs')).default,
  ...(await import('./lib/checks/s2-paper-consistency.mjs')).default,
  ...(await import('./lib/checks/s3-governance-pipeline.mjs')).default,
  ...(await import('./lib/checks/api-0-preflight.mjs')).default,
  ...(await import('./lib/checks/api-1-fixture.mjs')).default,
  ...(await import('./lib/checks/api-2-semantic-card.mjs')).default,
  ...(await import('./lib/checks/api-3-interlock-f5.mjs')).default,
  ...(await import('./lib/checks/api-4-attribution-readback.mjs')).default,
  ...(await import('./lib/checks/api-5-daq-freshness.mjs')).default,
  ...(await import('./lib/checks/plc-scenario.mjs')).default,
]

// harness 源码指纹：检查器+工具+入口任一改动都会改变指纹（审计要求：结果可追溯到代码版本）
const HARNESS_FILES = ['run.mjs', 'lib/util.mjs', 'lib/report.mjs',
  'lib/checks/s1-inventory.mjs', 'lib/checks/s2-paper-consistency.mjs', 'lib/checks/s3-governance-pipeline.mjs',
  'lib/checks/api-0-preflight.mjs', 'lib/checks/api-1-fixture.mjs', 'lib/checks/api-2-semantic-card.mjs',
  'lib/checks/api-3-interlock-f5.mjs', 'lib/checks/api-4-attribution-readback.mjs', 'lib/checks/api-5-daq-freshness.mjs',
  'lib/checks/plc-scenario.mjs']
const harnessHash = sha256(HARNESS_FILES.map(f => {
  try { return readFileSync(join(HERE, f), 'utf8') } catch { return `MISSING:${f}` }
}).join('\n%%\n'))
let gitCommit = 'unknown'
try {
  gitCommit = (await import('node:child_process')).execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch { /* 非 git 环境容错 */ }

const rid = mkRunId()
const outDir = ensureDir(join(REPO, 'bench', 'results', rid))
const ctx = {
  REPO, outDir, seed, rng: mulberry32(seed), base, repeats, rep: 0,
  api: makeApi(base), fixture: {}, teardownStack: [], serverUp: false,
}

const wanted = c => (!only || only.includes(c.meta.id))
const staticChecks = CHECKS.filter(c => c.meta.tier === 'static' && wanted(c))
const apiChecks = CHECKS.filter(c => c.meta.tier === 'api' && wanted(c))
const plcChecks = CHECKS.filter(c => c.meta.tier === 'plc' && wanted(c))

async function runCheck(c) {
  const label = `[${c.meta.tier}] ${c.meta.id} · ${c.meta.title}`
  try {
    if ((c.meta.requires ?? []).includes('server') && !ctx.serverUp) {
      const r = skip(c.meta.id, c.meta, '需要运行中的平台实例（api-0 preflight 未通过）——本层诚实跳过，不影响静态层结论')
      console.log(`  ↓ SKIP ${label}（无服务器）`)
      return r
    }
    if ((c.meta.requires ?? []).includes('sim') && !ctx.simUp) {
      const r = skip(c.meta.id, c.meta, '需要 PLC 模拟器（plc-0 未通过）——本层诚实跳过')
      console.log(`  ↓ SKIP ${label}（无模拟器）`)
      return r
    }
    const r = await c.run(ctx)
    console.log(`  ${r.status === 'pass' ? '✔' : r.status === 'warn' ? '▲' : r.status === 'skip' ? '↓' : '✘'} ${label}  score=${r.score}${r.note ? `  (${r.note})` : ''}`)
    return r
  } catch (err) {
    console.log(`  ✘ ${label}  异常: ${err?.message ?? err}`)
    return mkResult(c.meta.id, c.meta, 'fail', 0, {}, [String(err?.stack ?? err)], '检查器异常')
  }
}

console.log(`\n=== AW-IndustrialBench · run ${rid} ===`)
console.log(`tier=${tier} seed=${seed} base=${base} harness=${harnessHash.slice(0, 8)} git=${gitCommit}\n`)

const raw = []
for (const c of staticChecks) raw.push({ rep: 0, ...(await runCheck(c)) })

let repSummaries = []
if (TIER_ORDER[tier] >= 1) {
  const reps = tier === 'full' ? repeats : 1
  for (let rep = 1; rep <= reps; rep++) {
    ctx.rep = rep
    if (rep > 1) ctx.fixture = {}
    let pass = 0, fail = 0, skipN = 0
    for (const c of apiChecks) {
      const r = { rep, ...(await runCheck(c)) }
      raw.push(r)
      if (r.status === 'pass') pass++
      else if (r.status === 'fail') fail++
      else if (r.status === 'skip') skipN++
    }
    repSummaries.push({ rep, pass, fail, skip: skipN })
    console.log(`  ── rep ${rep}/${reps}: pass=${pass} fail=${fail} skip=${skipN}`)
  }
}
if (TIER_ORDER[tier] >= 3) {
  for (const c of plcChecks) raw.push({ rep: 0, ...(await runCheck(c)) })
}
for (const fn of ctx.teardownStack.splice(0).reverse()) { try { await fn() } catch { /* 尽力而为 */ } }

// ── 合并（full 层同一检查多轮 → 判定取最严，指标取首轮，时延类聚合范围）──
const byId = new Map()
for (const r of raw) {
  if (!byId.has(r.id)) byId.set(r.id, [])
  byId.get(r.id).push(r)
}
const results = [...byId.values()].map(list => {
  const first = list[0]
  if (list.length === 1) return first
  const statuses = list.map(r => r.status)
  const status = statuses.every(s => s === 'pass') ? 'pass' : statuses.includes('fail') ? 'fail' : statuses.every(s => s === 'skip') ? 'skip' : 'warn'
  const score = Math.min(...list.map(r => r.score))
  return { ...first, status, score, reps: list.map(r => ({ rep: r.rep, status: r.status, score: r.score })) }
})

// ── 汇总与落盘 ─────────────────────────────────────────────
const DIMS = {
  D1: '数据采集面', D2: '写控治理面', D3: '智能体面', D4: '编排协作面',
  D5: '记忆上下文面', D6: '互操作面', D7: '审计归因面', D8: '性能伸缩面', D0: '论文-代码一致性',
}
const dimOf = {}
for (const d of Object.keys(DIMS)) dimOf[d] = { got: 0, w: 0, checks: 0 }
const total = { got: 0, w: 0, pass: 0, fail: 0, warn: 0, skip: 0 }
for (const r of results) {
  if (r.status === 'skip') { total.skip++; continue }
  total.w += r.weight; total.got += r.score * r.weight
  if (r.status === 'pass') total.pass++; else if (r.status === 'warn') total.warn++; else total.fail++
  for (const d of r.dims ?? []) { if (dimOf[d]) { dimOf[d].got += r.score * r.weight; dimOf[d].w += r.weight; dimOf[d].checks++ } }
}
const dims = Object.entries(DIMS).filter(([d]) => dimOf[d].w > 0)
  .map(([d, name]) => ({ id: d, name, score: dimOf[d].w ? dimOf[d].got / dimOf[d].w : 0, checks: dimOf[d].checks }))
const overall = total.w ? total.got / total.w : 0

const env = {
  runId: rid, tier, seed, base, startedAt: new Date().toISOString(),
  node: process.version, platform: `${process.platform} ${process.arch}`,
  configHash: sha256(JSON.stringify({ tier, seed, only, repeats })),
  harnessHash, gitCommit, harnessFiles: HARNESS_FILES.length,
  reps: repSummaries.length ? repSummaries : undefined,
  total: { ...total, overall },
}
writeJson(join(outDir, 'run.json'), { env, dims, results })
writeText(join(outDir, 'config-hash.txt'), env.configHash)
const { md, html } = renderReport({ env, dims, results })
writeText(join(outDir, 'report.md'), md)
writeText(join(outDir, 'report.html'), html)

console.log(`\n总体评分: ${(overall * 100).toFixed(1)} / 100  （pass ${total.pass} · warn ${total.warn} · fail ${total.fail} · skip ${total.skip}）`)
for (const d of dims) console.log(`  ${d.id} ${d.name.padEnd(10, '　')} ${(d.score * 100).toFixed(1)}`)
console.log(`\n产物: ${outDir}{/run.json,/report.md,/report.html}`)
console.log(`复现: node bench/run.mjs --tier ${tier} --seed ${seed}${tier !== 'static' ? ` --base ${base}` : ''}${tier === 'full' ? ` --repeats ${repeats}` : ''}`)
process.exit(total.fail > 0 ? 1 : 0)
