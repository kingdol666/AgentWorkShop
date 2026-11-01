#!/usr/bin/env node
/**
 * bench/tools/build-protocol-matrix.mjs —— E1 场景×协议一致性矩阵生成器
 *
 * 目的: 把 `bench/results/<runId>/run.json` 里已有的结构化数据整理成论文可直接引用的
 * 「场景 × 协议」矩阵,并把**没有采集到的格**显式标成 `NOT-COLLECTED`,
 * 避免把"只有 2 个场景有拦截图"写成"多场景多协议已验证"。
 *
 * 只做重组,不产生新判定:
 *   - 主场景行走 `run.json.lines[]`(P2/P3 供给的五协议线,含 f5 探针计数)
 *   - 第二场景行走 `run.json.portability.lines[]`(P8 换场景后的线)
 *   - 合法写语料(false-block 分母)在现有 run 中不存在 → 一律 `absent`(这是 FINDING,不是缺省 0)
 *
 * 用法:
 *   node bench/tools/build-protocol-matrix.mjs                       # 自动选最近一次干净 run
 *   node bench/tools/build-protocol-matrix.mjs --pipeline <runId>
 *   node bench/tools/build-protocol-matrix.mjs --pipeline <a> --replicate <b>
 *   node bench/tools/build-protocol-matrix.mjs --out bench/results/<dir>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESULTS = join(REPO, 'bench', 'results')
const args = process.argv.slice(2)
const val = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }

function readRun(id) {
  const file = join(RESULTS, id, 'run.json')
  if (!existsSync(file)) throw new Error(`run.json not found: ${file}`)
  return { id, json: JSON.parse(readFileSync(file, 'utf8')) }
}

function latestClean() {
  const cands = readdirSync(RESULTS)
    .map(id => ({ id, file: join(RESULTS, id, 'run.json') }))
    .filter(x => existsSync(x.file))
    .map(x => { try { return { id: x.id, json: JSON.parse(readFileSync(x.file, 'utf8')) } } catch { return null } })
    .filter(Boolean)
    .filter(x => Array.isArray(x.json.checks) && Array.isArray(x.json.lines) && x.json.portability?.agg)
    .filter(x => !x.json.checks.some(c => c.status === 'fail'))
    .sort((a, b) => String(b.json.env?.startedAt ?? '').localeCompare(String(a.json.env?.startedAt ?? '')))
  if (cands.length === 0) throw new Error('no clean pipeline run found (need checks+lines+portability and 0 fail)')
  return cands[0]
}

const parseF5 = (v) => {
  if (typeof v !== 'string') return { rejected: null, total: null }
  const m = v.match(/^(\d+)\/(\d+)$/)
  return m ? { rejected: Number(m[1]), total: Number(m[2]) } : { rejected: null, total: null }
}

/**
 * 探针类别: run.json 只存 rejected/total,不存类别;类别由条数与 pipeline.mjs 的实现对应:
 *   6 条 = 4 结构(hi+15% / lo-15% / 1e6 / -50) + 2 软窗(window.max+20% / window.min-20%)  [pipeline.mjs:340-346]
 *   3 条 = 全结构(hi+15% / lo-15% / 1e6)                                                 [pipeline.mjs:1263-1267]
 * 条数对不上就报 unknown —— 不猜。
 */
const probeClasses = (total) => total === 6 ? 'structural+soft-window' : total === 3 ? 'structural' : 'unknown'

function rowsFromRun({ id, json }) {
  const rows = []
  const primary = json.lineProfile?.preset ?? 'primary-scene'
  const secondary = json.portability?.agg?.preset ?? 'secondary-scene'

  for (const l of json.lines ?? []) {
    const f5 = Number.isFinite(l.f5Rejected) && Number.isFinite(l.f5Total)
      ? { rejected: l.f5Rejected, total: l.f5Total }
      : { rejected: null, total: null }
    rows.push({
      scene: primary,
      protocol: String(l.protocol ?? '').toLowerCase(),
      role: l.satellite ? 'acquisition-only' : 'writable',
      daqSamples: l.daqSamples ?? null,
      probesRejected: f5.rejected,
      probesTotal: f5.total,
      probeClasses: probeClasses(f5.total),
      falseBlockCount: l.falseBlock ?? null,
      falseBlockCorpus: 'absent',
      readbackDelta: l.readbackDelta ?? null,
      source: id,
    })
  }
  for (const l of json.portability?.lines ?? []) {
    const f5 = parseF5(l.f5)
    rows.push({
      scene: secondary,
      protocol: String(l.protocol ?? '').toLowerCase(),
      role: l.satellite ? 'acquisition-only' : 'writable',
      daqSamples: l.daqSamples ?? null,
      probesRejected: f5.rejected,
      probesTotal: f5.total,
      probeClasses: probeClasses(f5.total),
      falseBlockCount: l.falseBlock ?? null,
      falseBlockCorpus: 'absent',
      readbackDelta: l.readbackDelta ?? null,
      source: id,
    })
  }
  return rows
}

const NOT_COLLECTED = [
  ['injection-line', 'scenarios.mjs 只跑闭环达标，无写准入探针（缺口 G1）'],
  ['wwtp-line', '同上'],
  ['anneal-line', '同上'],
  ['biax-line', 'P10 无负探针 / 合法语料'],
]

const COLS = ['scene', 'protocol', 'role', 'daqSamples', 'probesRejected', 'probesTotal', 'probeClasses', 'falseBlockCount', 'falseBlockCorpus', 'readbackDelta', 'source']

function toCsv(rows) {
  const line = (r) => COLS.map((c) => {
    const v = r[c]
    if (v == null) return ''
    const s = String(v)
    return s.includes(',') ? `"${s}"` : s
  }).join(',')
  return [COLS.join(','), ...rows.map(line)].join('\n')
}

function aggByScene(rows) {
  const out = new Map()
  for (const r of rows) {
    const cur = out.get(r.scene) ?? { scene: r.scene, protocols: new Set(), writable: 0, samples: 0, probes: 0, rejected: 0, readback: 0 }
    cur.protocols.add(r.protocol)
    if (r.role === 'writable') cur.writable++
    cur.samples += r.daqSamples ?? 0
    cur.probes += r.probesTotal ?? 0
    cur.rejected += r.probesRejected ?? 0
    if (r.readbackDelta != null) cur.readback++
    out.set(r.scene, cur)
  }
  return [...out.values()]
}

const mainRun = val('pipeline') ? readRun(val('pipeline')) : latestClean()
const repRun = val('replicate') ? readRun(val('replicate')) : null
const rows = rowsFromRun(mainRun)
const repRows = repRun ? rowsFromRun(repRun) : []

function judgementDiff(a, b) {
  const key = (r) => `${r.scene}|${r.protocol}|${r.role}`
  const mapB = new Map(b.map(r => [key(r), r]))
  const diffs = []
  for (const r of a) {
    const o = mapB.get(key(r))
    if (!o) { diffs.push(`${key(r)}: missing in replicate`); continue }
    for (const f of ['probesRejected', 'probesTotal', 'falseBlockCount']) {
      if ((r[f] ?? null) !== (o[f] ?? null)) diffs.push(`${key(r)}.${f}: ${r[f]} -> ${o[f]}`)
    }
  }
  for (const o of b) if (!a.some(r => key(r) === key(o))) diffs.push(`${key(o)}: extra in replicate`)
  return diffs
}

const scenes = aggByScene(rows)
const md = [
  '# E1 场景 × 协议一致性矩阵',
  '',
  `- 主 run: \`${mainRun.id}\`（git ${mainRun.json.env?.gitCommit?.slice(0, 8) ?? '?'}, seed ${mainRun.json.env?.seed ?? '?'}）`,
  repRun ? `- 复现 run: \`${repRun.id}\`` : '- 复现 run: 未提供（论文表格须附复现比对）',
  `- 生成时间: ${new Date().toISOString()}`,
  '',
  '| 场景 | 协议数 | 可写路由 | 采集样本 | 探针拒绝 | 回读可用 |',
  '|---|---|---|---|---|---|',
  ...scenes.map(s => `| ${s.scene} | ${s.protocols.size} | ${s.writable} | ${s.samples} | ${s.rejected}/${s.probes} | ${s.readback}/${s.writable} |`),
  '',
  '### 探针构成（拒绝数只能给合计：run.json 不存按类拒绝）',
  '',
  '| 场景 | 结构类探针 | 软窗类探针 | 合计拒绝 |',
  '|---|---|---|---|',
  ...scenes.map((s) => {
    const rowsOfScene = rows.filter(r => r.scene === s.scene && r.probesTotal != null)
    let structural = 0
    let soft = 0
    for (const r of rowsOfScene) {
      if (r.probeClasses === 'structural') structural += 3
      else if (r.probeClasses === 'structural+soft-window') { structural += 4; soft += 2 }
    }
    const rejected = rowsOfScene.reduce((a, r) => a + (r.probesRejected ?? 0), 0)
    const total = rowsOfScene.reduce((a, r) => a + (r.probesTotal ?? 0), 0)
    return `| ${s.scene} | ${structural} | ${soft} | ${rejected}/${total} |`
  }),
  '',
  '## 未采集场景（必须留在表里，不得删除）',
  '',
  '| 场景 | 状态 | 原因 |',
  '|---|---|---|',
  ...NOT_COLLECTED.map(([s, why]) => `| ${s} | NOT-COLLECTED | ${why} |`),
  '',
  '## 口径说明（写进论文脚注）',
  '',
  '1. `probeClasses`：6 条/路由 = 4 结构 + 2 软窗（cast-film）；3 条/路由 = 全结构（film-line）。',
  '   两类的拦截者不同——结构类由硬量程拒绝（不可旁路），软窗类由配方/产品/参数基准限界拒绝（`benchArm=no-interlock` 可放行）。',
  '   论文必须按类分列，不得合并成「33/33 全部拦截」一个数。',
  '2. `falseBlockCorpus=absent`：本 run 没有任何合法写语料 → **不能报告误拦率**；',
  '   需要 E1 的 legal corpus（每路由 3 区间内值 + 1 边界值）。',
  '3. `readbackDelta` 为空表示该协议驱动不返回执行器回读，不等于回读失败。',
  repRun ? '' : '4. 未提供复现 run → 本表只能作单次观察，不得作为可复现结论。',
  '',
  ...(repRun
    ? [
        '## 复现一致性（判定类字段）',
        '',
        judgementDiff(rows, repRows).length === 0
          ? '- PASS：两 run 的场景/协议/角色/探针计数/误拦计数逐项一致。'
          : `- FAIL：${judgementDiff(rows, repRows).length} 处判定类差异\n${judgementDiff(rows, repRows).map(d => `  - ${d}`).join('\n')}`,
        '',
      ]
    : []),
].join('\n')

const out = val('out')
if (out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'protocol-matrix.csv'), `${toCsv(rows)}\n`)
  writeFileSync(join(out, 'protocol-matrix.md'), md)
  if (repRun) writeFileSync(join(out, 'protocol-matrix-replicate.csv'), `${toCsv(repRows)}\n`)
}
process.stdout.write(`${md}\n`)
if (!out) process.stdout.write(`\n提示: 加 --out <dir> 可落盘 protocol-matrix.csv/.md\n`)
