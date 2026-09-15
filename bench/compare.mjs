#!/usr/bin/env node
/**
 * bench/compare.mjs —— 复现性判定工具（PIPELINE.md 阶段 F 的执行器）。
 *
 * 对比两次运行的 run.json，按"判定类/环境类"二分契约给出机器可验证结论：
 *   判定类指标（拦截率/误拦率/边界/归因/回读/静态锚点/PLC 离散结果）必须逐位一致；
 *   环境类指标（时延/新鲜度/物理残差）只报告差异，不作为门槛。
 *
 * 用法：
 *   node bench/compare.mjs --a 20260914025516-fx0 --b 20260914103000-ab12
 *   node bench/compare.mjs --baseline 20260914-baseline --b <新runId>
 * 参数可填 runId（bench/results/<id>/run.json）、基线标签（bench/baselines/<label>/run.json）
 * 或 run.json 直接路径。自动识别两种 schema：run.mjs 产物（env/dims/results）
 * 与 e1-lite.mjs 产物（env/rows/aggregate）。
 *
 * 输出：stdout 摘要 + bench/results/compare-<ts>-<A>-vs-<B>.md
 * 退出码：0 = REPRODUCIBLE；1 = NOT REPRODUCIBLE；2 = 输入错误
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }

// ── 判定契约：每个检查 id → 判定类指标白名单 ─────────────────────────────
// null  = 该检查全部指标均为判定类（静态清单/锚点类，本就确定性）
// []    = 该检查全部指标均为环境类（纯时延/新鲜度抽样）
// ['k1']= 白名单为判定类，其余指标自动归环境类并报告差异
const JUDGE = {
  's1-inventory': null,
  's2-paper-consistency': null,
  's3-governance-pipeline': null,
  'api-0-preflight': ['how', 'role'],
  'api-1-fixture': ['created', 'steps', 'window'],
  'api-2-semantic-card': ['ok', 'total'],
  'api-3-interlock-f5': ['intercept_rate', 'false_block_rate', 'attacks', 'intercepted', 'legit', 'legit_ok', 'boundary_cases', 'boundary_ok', 'eq1_branch_coverage'],
  'api-4-attribution-readback': ['writes', 'readback_ok', 'readback_rate', 'new_anchors', 'attribution_rate', 'tolerance'],
  'api-5-daq-freshness': [],
  'plc-0-simulator': ['protocols'],
  'plc-1-realpath': ['protocols_ok', 'total'],
  'plc-2-closedloop': ['real_write_ok', 'sp_readback', 'f5_rejected', 'legal_write_ok', 'f2_pv_freeze_alarm'],
  'plc-4-fault': ['offline_detected', 'reconnected'],
}
// 带容差的"半判定"指标：仅对已列入 JUDGE 白名单的数值键生效（键格式 checkId:key）。
// 当前白名单全部为离散/计数/布尔值，故无激活项；物理残差类（pv_final 等）归环境类，
// 只报告不设门槛——这是物理引擎采样时序决定的设计选择，不是疏漏。
const TOLERATED = {
  'plc-2-closedloop:pv_final': 0.5,
}

function resolveRun(ref) {
  const candidates = isAbsolute(ref)
    ? [ref]
    : [join(REPO, 'bench', 'results', ref, 'run.json'),
        join(REPO, 'bench', 'baselines', ref, 'run.json'),
        join(REPO, ref)]
  let hit = candidates.find(existsSync)
  // 候选解析到「运行目录」而非 run.json 文件时，自动落到目录内的 run.json——
  // 调用方常直接把 `bench/results/<runId>` 目录（如 ls -dt 的输出）当 ref 传进来。
  if (hit && statSync(hit).isDirectory() && existsSync(join(hit, 'run.json'))) hit = join(hit, 'run.json')
  if (!hit) {
    // 裸基线标签：run.json 在子目录里（如 <label>/run-plc-fx0/run.json）。
    // 多个候选时拒绝解析——标签指到哪份运行必须显式（判定工具不允许含糊）。
    for (const dir of [join(REPO, 'bench', 'baselines', ref), join(REPO, 'bench', 'results', ref), join(REPO, ref)]) {
      if (!existsSync(dir)) continue
      try {
        const subs = readdirSync(dir).filter(s => existsSync(join(dir, s, 'run.json'))).sort()
        if (subs.length === 1) { hit = join(dir, subs[0], 'run.json'); break }
        if (subs.length > 1) throw new Error(`"${ref}" 含多份运行 (${subs.join(', ')})——请显式指定到子目录, 例如 --baseline ${ref}/${subs[0]}`)
      } catch (e) { if (e instanceof Error && e.message.startsWith('"')) throw e }
    }
  }
  if (!hit) throw new Error(`找不到运行结果: ${ref}`)
  return { ref, path: hit, json: JSON.parse(readFileSync(hit, 'utf8')) }
}

function diffJudge(checkId, ma, mb) {
  // 返回 { gateFails: string[], tolerated: string[], judgePairs: [key,a,b,verdict][] }
  const keys = JUDGE[checkId] === undefined ? null : JUDGE[checkId]
  const gateFails = [], tolerated = [], judgePairs = [], envPairs = []
  const allKeys = [...new Set([...Object.keys(ma ?? {}), ...Object.keys(mb ?? {})])]
  for (const k of allKeys) {
    const va = ma?.[k], vb = mb?.[k]
    const tolKey = `${checkId}:${k}`
    if (keys === null || (Array.isArray(keys) && keys.includes(k))) {
      let verdict = 'ok'
      if (TOLERATED[tolKey] !== undefined) {
        const tol = TOLERATED[tolKey]
        if (typeof va === 'number' && typeof vb === 'number' && Math.abs(va - vb) <= tol) verdict = 'tol'
        else if (va !== vb) verdict = 'FAIL'
      } else if (JSON.stringify(va) !== JSON.stringify(vb)) verdict = 'FAIL'
      if (verdict === 'FAIL') gateFails.push(`${checkId}.${k}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`)
      if (verdict === 'tol') tolerated.push(`${checkId}.${k}: ${va} → ${vb} (±${TOLERATED[tolKey]})`)
      judgePairs.push([k, va, vb, verdict])
    } else {
      envPairs.push([k, va, vb])
    }
  }
  return { gateFails, tolerated, judgePairs, envPairs }
}

function comparePipelineRuns(A, B) {
  if (A.json.aggregate && !B.json.aggregate) throw new Error('schema 不匹配: A 是 e1-lite 产物（aggregate）而 B 是 run.mjs 产物（results）——两者不可比')
  if (B.json.aggregate && !A.json.aggregate) throw new Error('schema 不匹配: B 是 e1-lite 产物（aggregate）而 A 是 run.mjs 产物（results）——两者不可比')
  const gateFails = [], tolerated = [], notes = [], envDeltas = []
  const ea = A.json.env ?? {}, eb = B.json.env ?? {}
  if (ea.tier !== eb.tier) gateFails.push(`tier 不一致: ${ea.tier} vs ${eb.tier}`)
  if (ea.seed !== eb.seed) gateFails.push(`seed 不一致: ${ea.seed} vs ${eb.seed}`)
  if (ea.harnessHash !== eb.harnessHash) notes.push(`harnessHash 不同（harness 源码在两次运行之间有改动，须确认改动不影响判定逻辑）: ${ea.harnessHash?.slice(0, 8)} vs ${eb.harnessHash?.slice(0, 8)}`)
  if (ea.gitCommit !== eb.gitCommit) notes.push(`gitCommit 不同: ${ea.gitCommit} vs ${eb.gitCommit}`)
  if (JSON.stringify(ea.configHash) !== JSON.stringify(eb.configHash)) notes.push(`configHash 不同（tier/seed/only/repeats 组合不同）: ${ea.configHash} vs ${eb.configHash}`)

  const ra = new Map((A.json.results ?? []).map(r => [r.id, r]))
  const rb = new Map((B.json.results ?? []).map(r => [r.id, r]))
  const ids = [...new Set([...ra.keys(), ...rb.keys()])]
  const rows = []
  for (const id of ids.sort()) {
    const x = ra.get(id), y = rb.get(id)
    if (!x || !y) { gateFails.push(`检查集不一致: ${id} 仅存在于 ${!x ? 'A（基线）' : 'B（新运行）'}`); rows.push([id, x?.status ?? '—', y?.status ?? '—', 'FAIL', '检查缺失']); continue }
    if (x.status !== y.status) { gateFails.push(`${id} status: ${x.status} → ${y.status}`) }
    const d = diffJudge(id, x.metrics, y.metrics)
    gateFails.push(...d.gateFails)
    tolerated.push(...d.tolerated)
    for (const [k, va, vb] of d.envPairs) {
      if (typeof va === 'number' && typeof vb === 'number') envDeltas.push(`${id}.${k}: ${va} → ${vb} (Δ${(vb - va >= 0 ? '+' : '')}${(vb - va).toFixed(1)})`)
      else if (JSON.stringify(va) !== JSON.stringify(vb)) envDeltas.push(`${id}.${k}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`)
    }
    rows.push([id, x.status, y.status, d.gateFails.length ? 'FAIL' : 'ok', d.judgePairs.filter(p => p[3] !== 'ok').map(p => `${p[0]}:${p[1]}→${p[2]}`).join('; ') || `${d.judgePairs.length} 项判定指标逐位一致`])
  }
  const overallA = ea.total?.overall, overallB = eb.total?.overall
  return { gateFails, tolerated, notes, envDeltas, rows, scores: [overallA, overallB], kind: 'pipeline' }
}

function compareE1Lite(A, B) {
  const gateFails = [], tolerated = [], notes = [], envDeltas = []
  const ea = A.json.env ?? {}, eb = B.json.env ?? {}
  if (ea.seed !== eb.seed) gateFails.push(`seed 不一致: ${ea.seed} vs ${eb.seed}`)
  const JUDGE_E1 = ['intercept_rates', 'window_breach_total', 'false_block_total', 'boundary_ok_total']
  const agA = A.json.aggregate ?? {}, agB = B.json.aggregate ?? {}
  const rows = []
  for (const arm of [...new Set([...Object.keys(agA), ...Object.keys(agB)])]) {
    const x = agA[arm], y = agB[arm]
    if (!x || !y) { gateFails.push(`消融臂缺失: ${arm}`); rows.push([arm, '—', '—', 'FAIL', '臂缺失']); continue }
    const parts = []
    for (const k of Object.keys(x)) {
      const va = x[k], vb = y?.[k]
      const isJudge = JUDGE_E1.includes(k)
      const same = JSON.stringify(va) === JSON.stringify(vb)
      if (isJudge && !same) gateFails.push(`e1-lite.${arm}.${k}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`)
      if (!isJudge) envDeltas.push(`e1-lite.${arm}.${k}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`)
      parts.push(`${k} ${same ? '=' : '≠'}${isJudge ? '' : '(env)'}`)
    }
    rows.push([`e1lite:${arm}`, 'pass', 'pass', gateFails.length ? 'FAIL' : 'ok', parts.join(', ')])
  }
  return { gateFails, tolerated, notes, envDeltas, rows, scores: [null, null], kind: 'e1-lite' }
}

// ── 主流程 ─────────────────────────────────────────────
// --selftest: 阴性对照自检——克隆基线、篡改一项判定类指标,断言门槛必须拒绝。
// 这是论文 §VII-C "the gate itself was validated by an injected tampered metric"
// 的可复现证据:任何人运行本命令即可验证判定门槛有牙,报告落盘留档。
if (args.includes('--selftest')) {
  const base = resolveRun(arg('baseline', '20260914-baseline/run-plc-fx0'))
  const tampered = JSON.parse(JSON.stringify(base.json))
  const victim = (tampered.results ?? []).find(r => r.id === 'api-3-interlock-f5')
  if (!victim) { console.error('selftest: 基线中无 api-3-interlock-f5,无法构造篡改'); process.exit(2) }
  victim.metrics.intercept_rate = 0.8333
  victim.metrics.intercepted = 5
  const B = { ref: 'selftest-tampered', path: '(in-memory)', json: tampered }
  const R = comparePipelineRuns(base, B)
  const caught = R.gateFails.some(g => g.includes('api-3-interlock-f5.intercept_rate')) && R.gateFails.some(g => g.includes('api-3-interlock-f5.intercepted'))
  const verdict = caught ? 'SELFTEST PASS（门槛正确拒绝篡改）' : 'SELFTEST FAIL（门槛漏检篡改——判定契约失效!）'
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const outMd = join(REPO, 'bench', 'results', `selftest-tamper-${ts}.md`)
  const L = ['# 篡改阴性对照自检（bench/compare.mjs --selftest）', '',
    `- 基线: \`${base.path}\``, '- 篡改: api-3-interlock-f5.intercept_rate 1 → 0.8333（且 intercepted 6 → 5）', '',
    '## 门槛捕获明细', '', ...R.gateFails.map(g => `- ${g}`), '', `## 结论: ${verdict}`, '']
  writeFileSync(outMd, L.join('\n'), 'utf8')
  console.log(`\n${verdict}`)
  console.log(`捕获项: ${R.gateFails.length} 项门槛失败（预期 ≥2 且含 intercept_rate/intercepted）`)
  R.gateFails.forEach(g => console.log(`  ✘ ${g}`))
  console.log(`报告: ${outMd}`)
  process.exit(caught ? 0 : 1)
}

const aRef = arg('a', arg('baseline', '')) || args[0] || ''
const bRef = arg('b', '') || args[1] || ''
if (!aRef || !bRef) {
  console.error('用法: node bench/compare.mjs --a <runId|baseline|path> --b <runId|path>\n      node bench/compare.mjs --baseline <label> --b <runId>')
  process.exit(2)
}
let A, B
try { A = resolveRun(aRef) } catch (e) { console.error('A:', e.message); process.exit(2) }
try { B = resolveRun(bRef) } catch (e) { console.error('B:', e.message); process.exit(2) }

const isE1 = !!A.json.aggregate && !!B.json.aggregate
const R = isE1 ? compareE1Lite(A, B) : comparePipelineRuns(A, B)
const verdict = R.gateFails.length === 0 ? 'REPRODUCIBLE' : 'NOT REPRODUCIBLE'

// ── 报告落盘 ───────────────────────────────────────────
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const safe = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
const outMd = join(REPO, 'bench', 'results', `compare-${ts}-${safe(A.ref)}-vs-${safe(B.ref)}.md`)
const L = []
L.push(`# 复现性判定: ${verdict}`)
L.push('')
L.push(`- A（基线）: \`${A.ref}\` → ${A.path}`)
L.push(`- B（新运行）: \`${B.ref}\` → ${B.path}`)
L.push(`- 契约: 判定类指标逐位一致 = REPRODUCIBLE；时延/新鲜度类只报告不设门槛（bench/compare.mjs JUDGE 契约表）`)
L.push('')
L.push('## 环境')
L.push('')
L.push('| | A | B |')
L.push('|---|---|---|')
L.push(`| tier/seed | ${A.json.env?.tier ?? 'e1-lite'}/${A.json.env?.seed ?? '—'} | ${B.json.env?.tier ?? 'e1-lite'}/${B.json.env?.seed ?? '—'} |`)
L.push(`| harnessHash | ${A.json.env?.harnessHash ?? '—'} | ${B.json.env?.harnessHash ?? '—'} |`)
L.push(`| gitCommit | ${A.json.env?.gitCommit ?? '—'} | ${B.json.env?.gitCommit ?? '—'} |`)
L.push(`| configHash | ${A.json.env?.configHash ?? '—'} | ${B.json.env?.configHash ?? '—'} |`)
if (R.scores[0] != null) L.push(`| 总体评分 | ${(R.scores[0] * 100).toFixed(1)} | ${(R.scores[1] * 100).toFixed(1)} |`)
L.push('')
for (const n of R.notes) L.push(`> NOTE: ${n}`)
if (R.notes.length) L.push('')
L.push('## 逐检查对比')
L.push('')
L.push('| 检查 | status A | status B | 判定 | 说明 |')
L.push('|---|---|---|---|---|')
for (const r of R.rows) L.push(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4].replaceAll('|', '\\|')} |`)
L.push('')
if (R.tolerated.length) {
  L.push('## 容差内判定（±范围一致）')
  L.push('')
  for (const t of R.tolerated) L.push(`- ${t}`)
  L.push('')
}
if (R.envDeltas.length) {
  L.push('## 环境类指标差异（不设门槛，如实记录）')
  L.push('')
  for (const e of R.envDeltas) L.push(`- ${e}`)
  L.push('')
}
if (R.gateFails.length) {
  L.push('## 门槛失败明细')
  L.push('')
  for (const g of R.gateFails) L.push(`- ${g}`)
  L.push('')
}
L.push(`## 结论: **${verdict}**`)
L.push('')
writeFileSync(outMd, L.join('\n'), 'utf8')

console.log(`\n=== 复现性判定 ===`)
console.log(`A = ${A.path}`)
console.log(`B = ${B.path}`)
for (const n of R.notes) console.log(`NOTE: ${n}`)
for (const r of R.rows) console.log(`  ${r[3] === 'ok' ? '✔' : '✘'} ${r[0].padEnd(28)} ${r[1]}→${r[2]}  ${r[4]}`)
for (const t of R.tolerated) console.log(`  ≈ ${t}`)
if (R.gateFails.length) { console.log(`门槛失败 ${R.gateFails.length} 项:`); for (const g of R.gateFails) console.log(`  ✘ ${g}`) }
console.log(`\n结论: ${verdict}`)
console.log(`报告: ${outMd}`)
process.exit(R.gateFails.length === 0 ? 0 : 1)
