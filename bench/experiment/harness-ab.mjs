#!/usr/bin/env node
/**
 * E5-lite · Harness 变体配对评测（WP-B2）
 *
 * 目的：给「经验包 / prompt overlay / 配置」这类**外壳变体**提供可解释的配对证据，
 * 产出正是晋升门（experience/gates.ts `PairedBenchResult`）要的入参：
 *   { pValue, primaryDelta, costDelta, n }
 *
 * 设计（与 bench/repeat-experiment.mjs 同口径：同 seed 配对、主终点=终末误差）：
 *  - 每个 seed 跑两次（臂 A=基线 profile，臂 B=候选 profile），配对求差；
 *  - 统计：配对 t 检验（双侧 p，t 分布）+ 均值差 + 成本差；
 *  - **不把 Agent 自述当判据**：两臂的 primary/cost 必须由外部 runner 以结构化 JSON 输出
 *    （runner 自己取平台独立数据面；本脚本只做配对与统计）。
 *
 * 用法：
 *   # 1) CI/自检：用合成数据验证统计与判定（不需要平台/模拟器）
 *   node bench/experiment/harness-ab.mjs --self-test
 *
 *   # 2) 真实配对（需平台 + 场景；runner 由调用方提供，打印一行 JSON）
 *   node bench/experiment/harness-ab.mjs \
 *     --seeds 1,2,3,4,5,6,7,8,9,10 \
 *     --cmd-a 'node bench/repeat-experiment.mjs --profile-baseline --seed {seed}' \
 *     --cmd-b 'node bench/repeat-experiment.mjs --profile-candidate --seed {seed}' \
 *     --out bench/results/harness-ab-<ts>/paired.json
 *
 * runner 契约（stdout 最后一行）：
 *   {"primary": 12.3, "cost": 0.42}      primary 越小越好（或按 --higher-better 反转）
 *   缺字段/非有限数 → 该 seed 记 excluded（不参与统计，不计为 0）
 *
 * 退出码：0 = 产出结果（无论显著与否）；2 = 有效配对不足（< --min-pairs）；1 = 用法/运行错误。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')

// ===== 统计基元（纯函数，便于自检）=====

/** 配对差样本均值 */
export function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** 样本标准差（n-1） */
export function sd(xs) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

/** t 分布双侧 p 值（正则化不完全 Beta；Numerical Recipes betacf 实现） */
export function tTwoSidedP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return 1
  const x = df / (df + t * t)
  return clamp01(betai(df / 2, 0.5, x))
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

/** 正则化不完全 Beta I_x(a,b) */
function betai(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a
  return x < (a + 1) / (a + b + 2)
    ? front * betacf(a, b, x)
    : 1 - Math.exp(Math.log(1 - x) * b + Math.log(x) * a - lbeta) / b * betacf(b, a, 1 - x)
}

function betacf(a, b, x) {
  const MAXIT = 200
  const EPS = 3e-12
  const FPMIN = 1e-300
  let qab = a + b
  let qap = a + 1
  let qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

function lnGamma(z) {
  const g = [76.1800917294715, -86.5053203294168, 24.0140982408309, -1.2317395724502, 0.1208650973866e-2, -0.5395239384953e-5]
  let y = z
  let tmp = z + 5.5
  tmp -= (z + 0.5) * Math.log(tmp)
  let ser = 1.00000000019
  for (let j = 0; j < 6; j++) ser += g[j] / ++y
  return -tmp + Math.log((2.506628274631 * ser) / z)
}

/**
 * 配对统计。
 * @param {Array<{seed:string|number, a:number, b:number, costA?:number, costB?:number}>} pairs
 * @param {{higherBetter?:boolean}} opts
 * @returns {{pValue:number|null, primaryDelta:number, costDelta:number, n:number, se:number|null, t:number|null, perSeed:Array}}
 */
export function pairedStats(pairs, opts = {}) {
  const sign = opts.higherBetter ? -1 : 1
  const deltas = pairs.map(p => sign * (p.a - p.b)) // 正 = B 更好（按"越小越好"归一）
  const costDeltas = pairs
    .filter(p => Number.isFinite(p.costA) && Number.isFinite(p.costB) && p.costA !== 0)
    .map(p => (p.costB - p.costA) / Math.abs(p.costA))
  const n = deltas.length
  const primaryDelta = n > 0 ? mean(deltas) : 0
  const costDelta = costDeltas.length > 0 ? mean(costDeltas) : 0
  if (n < 2) {
    return { pValue: null, primaryDelta, costDelta, n, se: null, t: null, perSeed: pairs }
  }
  const s = sd(deltas)
  const se = s / Math.sqrt(n)
  if (se === 0) {
    // 全部差相同：无方差 → 有差即"确定"，无差则 p=1
    return { pValue: primaryDelta === 0 ? 1 : 0, primaryDelta, costDelta, n, se: 0, t: null, perSeed: pairs }
  }
  const t = primaryDelta / se
  return { pValue: tTwoSidedP(t, n - 1), primaryDelta, costDelta, n, se, t, perSeed: pairs }
}

// ===== runner 执行 =====

function runArm(cmd, seed) {
  const line = String(cmd).replaceAll('{seed}', String(seed))
  const res = spawnSync(line, { shell: true, encoding: 'utf8', cwd: REPO, timeout: 30 * 60_000 })
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim()
  const last = out.split(/\r?\n/).filter(Boolean).pop() ?? ''
  try {
    const j = JSON.parse(last)
    const primary = Number(j.primary)
    const cost = Number(j.cost)
    if (!Number.isFinite(primary)) return { ok: false, reason: 'primary 非有限数', raw: last }
    return { ok: true, primary, cost: Number.isFinite(cost) ? cost : undefined }
  }
  catch {
    return { ok: false, reason: `runner 末行不是 JSON（exit=${res.status}）`, raw: last.slice(0, 200) }
  }
}

// ===== 自检（合成数据）=====

function selfTest() {
  let pass = 0
  let fail = 0
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`) }
    else { fail++; console.log(`  FAIL ${name} — ${detail}`) }
  }
  // 已知值：t=2.262, df=9 → 双侧 p≈0.05
  const p1 = tTwoSidedP(2.262157, 9)
  ok('t 分布 p(t=2.262,df=9)≈0.05', Math.abs(p1 - 0.05) < 0.002, `p=${p1.toFixed(4)}`)
  // t=0 → p=1
  ok('t=0 → p=1', Math.abs(tTwoSidedP(0, 5) - 1) < 1e-9)
  // 显著改善：B 比 A 小 1（越小越好）
  const good = Array.from({ length: 10 }, (_, i) => ({ seed: i, a: 110 + i * 0.1, b: 109 + i * 0.1, costA: 100, costB: 101 }))
  const stGood = pairedStats(good)
  ok('一致改善 → p 极小 + Δ>0', stGood.pValue < 1e-6 && stGood.primaryDelta > 0, `p=${stGood.pValue}, Δ=${stGood.primaryDelta}`)
  ok('成本 +1% → costDelta≈0.01', Math.abs(stGood.costDelta - 0.01) < 1e-9, String(stGood.costDelta))
  // 无差异（同值，se=0）
  const same = Array.from({ length: 6 }, (_, i) => ({ seed: i, a: 5, b: 5 }))
  const stSame = pairedStats(same)
  ok('完全无差 → p=1', stSame.pValue === 1)
  // 劣化
  const bad = Array.from({ length: 10 }, (_, i) => ({ seed: i, a: 100 + i, b: 101 + i }))
  const stBad = pairedStats(bad)
  ok('一致劣化 → Δ<0', stBad.primaryDelta < 0, `Δ=${stBad.primaryDelta}`)
  // 配对不足
  const one = pairedStats([{ seed: 1, a: 1, b: 2 }])
  ok('n=1 → pValue=null（不硬凑显著）', one.pValue === null)
  // higherBetter
  const higher = pairedStats([{ seed: 1, a: 1, b: 2 }, { seed: 2, a: 1, b: 2 }], { higherBetter: true })
  ok('higherBetter 反转方向', higher.primaryDelta > 0, `Δ=${higher.primaryDelta}`)

  console.log(`\n=== harness-ab self-test: ${fail === 0 ? 'PASS' : 'FAIL'}(${pass}/${pass + fail}) ===`)
  return fail === 0 ? 0 : 1
}

// ===== main =====

function argOf(name, dflt = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  const seeds = String(argOf('seeds', '1,2,3,4,5')).split(',').map(s => s.trim()).filter(Boolean)
  const cmdA = argOf('cmd-a')
  const cmdB = argOf('cmd-b')
  const minPairs = Number(argOf('min-pairs', 3))
  const higherBetter = process.argv.includes('--higher-better')
  if (!cmdA || !cmdB) {
    console.error('用法：--seeds 1,2,3 --cmd-a "<runner A>" --cmd-b "<runner B>" [--higher-better] [--min-pairs 3] [--out file.json]')
    console.error('或：--self-test（合成数据自检）')
    return 1
  }
  const pairs = []
  const excluded = []
  for (const seed of seeds) {
    const a = runArm(cmdA, seed)
    const b = runArm(cmdB, seed)
    if (!a.ok || !b.ok) {
      excluded.push({ seed, armA: a.ok ? null : a.reason, armB: b.ok ? null : b.reason })
      continue
    }
    pairs.push({ seed, a: a.primary, b: b.primary, costA: a.cost, costB: b.cost })
  }
  const stats = pairedStats(pairs, { higherBetter })
  const out = {
    kind: 'harness-ab-paired',
    at: new Date().toISOString(),
    seeds: seeds.length,
    pairs: pairs.length,
    excluded,
    pValue: stats.pValue,
    primaryDelta: stats.primaryDelta,
    costDelta: stats.costDelta,
    higherBetter,
    perSeed: stats.perSeed,
  }
  const outPath = argOf('out')
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
    console.log(`[harness-ab] 结果已写入 ${outPath}`)
  }
  console.log(JSON.stringify({ pValue: out.pValue, primaryDelta: out.primaryDelta, costDelta: out.costDelta, n: out.pairs, excluded: excluded.length }))
  if (pairs.length < minPairs) {
    console.error(`[harness-ab] 有效配对 ${pairs.length} < ${minPairs}：证据不足（不产出晋升依据）`)
    return 2
  }
  return 0
}

// 仅当以本文件为入口运行时执行 main（被测试 import 时不得触发 CLI）
const invokedDirectly = process.argv[1] ? resolve(process.argv[1]).endsWith('harness-ab.mjs') : false
if (invokedDirectly) process.exitCode = main()
