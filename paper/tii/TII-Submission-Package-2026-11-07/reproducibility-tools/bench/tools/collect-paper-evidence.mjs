#!/usr/bin/env node
/**
 * bench/tools/collect-paper-evidence.mjs —— 论文证据轮汇整(2026-11-05 新增)
 *
 * 用法(在隔离环境块外、仓库根执行):
 *   node bench/tools/collect-paper-evidence.mjs --runs <dir1,dir2,...> --out <paper-pipeline-dir>
 *
 * 行为(只读输入目录,不改动任何 run 产物):
 *   1. 逐目录读取 run.json/qualify.json/readback-mismatch.json,提取 verdict 与分母;
 *   2. 写 manifest.json(本轮全部 run 目录+判定)+ SHA256SUMS.txt(全产物文件);
 *   3. 写 report.md(人读汇总:每块判定/分母/诚实披露)。
 *
 * 退出码:0 = 所有非预检运行记录的状态为 PASS/QUALIFIED;1 = 有失败、缺失或仅预检记录。
 * 此退出码和 allPass 只汇总运行 verdict，不判定其是否满足论文证据资格。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, openSync, closeSync, unlinkSync, rmdirSync } from 'node:fs'
import { join, resolve, relative, basename, dirname, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const runs = arg('runs', '').split(',').map(s => s.trim()).filter(Boolean)
const outArg = arg('out', '')
if (!runs.length || !outArg.trim()) { console.error('用法: --runs <dir1,dir2,...> --out <nonexistent-dir>'); process.exit(1) }
const outDir = resolve(outArg)

function canonicalDirectory(path, label) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a regular directory, not a symlink: ${path}`)
  return realpathSync(path)
}

function isWithin(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

const runDirs = runs.map(path => canonicalDirectory(resolve(path), 'run input'))
if (new Set(runDirs).size !== runDirs.length) throw new Error('duplicate run input directory')
const runNames = runDirs.map(path => basename(path))
if (new Set(runNames).size !== runNames.length) throw new Error('run input directories must have unique names for an auditable manifest')
const outParentPath = dirname(outDir)
const outParentInfo = lstatSync(outParentPath)
if (outParentInfo.isSymbolicLink() || !outParentInfo.isDirectory()) throw new Error(`output parent must be an existing regular directory: ${outParentPath}`)
const outParent = realpathSync(outParentPath)
const canonicalOutDir = resolve(outParent, basename(outDir))
if (runDirs.some(dir => isWithin(dir, canonicalOutDir) || isWithin(canonicalOutDir, dir))) {
  throw new Error('output directory must not overlap any input run directory')
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const strictVerdict = (pass) => pass === true ? 'PASS' : pass === false ? 'FAIL' : 'UNKNOWN'

const verdictOf = (dir, filesByName) => {
  const readJson = (name) => {
    const path = filesByName.get(name)
    if (!path) return null
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
      return value
    }
    catch (error) { throw new Error(`invalid ${name} in ${basename(dir)}: ${error.message}`) }
  }

  const q = readJson('qualify.json')
  if (q) {
    const checks = Array.isArray(q.checks) ? q.checks : []
    const verdict = q.status ?? q.verdict ?? 'UNKNOWN'
    const details = checks.map(c => `${c.name}=${c.status ?? (c.ok ? 'ok' : 'fail')}`)
    const scope = q.scope ? `scope=${q.scope}` : 'legacy-preflight-scope=unknown'
    const paperEvidence = q.scope === 'PRECHECK_ONLY_NOT_PAPER_EVIDENCE' ? 'paperEvidence=false' : ''
    return { kind: 'agent-preflight', verdict, detail: [scope, paperEvidence, ...details].filter(Boolean).join(' ') }
  }

  const mismatch = readJson('readback-mismatch.json')
  if (mismatch) {
    const r = mismatch
    return { kind: 'readback-mismatch', verdict: strictVerdict(r.pass), detail: `downgraded=${r.downgraded} mismatchVisible=${r.mismatchVisible} node=${r.node?.id}` }
  }

  const run = readJson('run.json')
  if (run) {
    const r = run
    if (r.totals) return {
      kind: 'scenario-probes', verdict: strictVerdict(r.pass),
      detail: `legal=${r.totals.legal?.[0]}/${r.totals.legal?.[1]} structural=${r.totals.structural?.[0]}/${r.totals.structural?.[1]} window=${r.totals.window?.[0]}/${r.totals.window?.[1]} readback=${r.totals.readback?.[0]}/${r.totals.readback?.[1]} windowFrac=${r.windowFrac}`,
    }
    return { kind: 'run', verdict: strictVerdict(r.pass), detail: '' }
  }
  return { kind: 'unknown', verdict: 'NO_MANIFEST', detail: '目录内未找到可识别的 run 清单' }
}

const allFiles = (dir) => {
  const acc = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const info = lstatSync(p)
      if (info.isSymbolicLink()) throw new Error(`symlink rejected while hashing: ${p}`)
      if (info.isDirectory()) walk(p)
      else if (info.isFile()) acc.push(p)
      else throw new Error(`unsupported filesystem entry while hashing: ${p}`)
    }
  }
  walk(dir)
  return acc
}

const manifest = {
  at: new Date().toISOString(),
  runs: [],
  allPass: true,
  containsPreflight: false,
  paperEvidenceQualification: 'NOT_ASSESSED',
}
const lines = ['# 论文证据轮汇总', '', `- 汇整时间: ${manifest.at}`, '', '| Run 目录 | 类型 | 判定 | 关键分母 |', '|---|---|---|---|']
const sums = []

for (const dir of runDirs) {
  // Validate and hash the entire input tree before creating any output. This
  // prevents unreadable files, malformed manifests, or symlinks from leaving a
  // partial evidence bundle behind.
  const files = allFiles(dir)
  if (!files.length) throw new Error(`input run directory contains no files: ${dir}`)
  const filesByName = new Map(files.map(file => [relative(dir, file).replaceAll('\\', '/'), file]))
  const v = verdictOf(dir, filesByName)
  // A preflight is operational readiness only, even if an older schema called
  // it QUALIFIED. Never let it make a paper evidence batch pass.
  const ok = v.kind !== 'agent-preflight' && (v.verdict === 'PASS' || v.verdict === 'QUALIFIED')
  if (!ok) manifest.allPass = false
  if (v.kind === 'agent-preflight') manifest.containsPreflight = true
  manifest.runs.push({ dir: basename(dir), kind: v.kind, verdict: v.verdict, detail: v.detail })
  lines.push(`| ${basename(dir)} | ${v.kind} | ${v.verdict} | ${v.detail} |`)
  for (const f of files) sums.push(`${sha256(f)}  ${relative(dir, f).replaceAll('\\', '/')}  (${basename(dir)})`)
}

const dupCheck = new Set()
for (const s of sums) {
  const name = s.split('  ')[1]
  if (dupCheck.has(name)) console.warn(`[warn] 同名产物(以 run 目录为前缀区分): ${name}`)
  dupCheck.add(name)
}
lines.push('', `- 运行状态汇总: **${manifest.allPass ? 'ALL PASS' : '存在 FAIL/未达标(逐行见上)'}**`, '- 论文证据资格: **NOT_ASSESSED**（本收集器不评估科学主张是否成立）', `- 产物校验: SHA256SUMS.txt(${sums.length} 文件)`, '')
// mkdir is the atomic no-replace reservation. A destination created after
// input validation still causes EEXIST rather than replacing an empty folder
// on POSIX or Windows.
mkdirSync(outDir, { recursive: false })
const createdFiles = []
try {
  for (const [name, contents] of [
    ['manifest.json', JSON.stringify(manifest, null, 2)],
    ['SHA256SUMS.txt', sums.sort().join('\n') + '\n'],
    ['report.md', lines.join('\n')],
  ]) {
    const path = join(outDir, name)
    const fd = openSync(path, 'wx')
    createdFiles.push(path)
    try { writeFileSync(fd, contents) }
    finally { closeSync(fd) }
  }
} catch (error) {
  for (const path of createdFiles.reverse()) {
    try { unlinkSync(path) } catch { /* preserve anything not created by this collector */ }
  }
  try { rmdirSync(outDir) } catch { /* leave a directory another process has modified */ }
  throw error
}
console.log(`汇整完成: ${outDir} (runs=${runs.length}, files=${sums.length}, allPass=${manifest.allPass})`)
process.exitCode = manifest.allPass ? 0 : 1
