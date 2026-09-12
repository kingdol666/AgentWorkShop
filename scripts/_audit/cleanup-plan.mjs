// 列出"计划删除"的清单(只读预览),供人工确认;支持 --class=A|B|C|D
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = process.cwd()
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined }
const cls = (arg('--class') ?? 'ALL').toUpperCase()

function walk(rel, out = []) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return out
  const st = statSync(full)
  if (st.isFile()) { out.push(rel); return out }
  for (const n of readdirSync(full)) walk(rel + '/' + n, out)
  return out
}
const size = list => list.reduce((s, r) => {
  try { return s + statSync(join(ROOT, r.split('/').join(sep))).size } catch { return s }
}, 0)

// A 类:纯生成产物 / 一次性走查截图 / scratch(文档零引用)
const A_DIRS = [
  'docs/audit/screenshots',
  'docs/experiments/results',
  'gui-test-screenshots',
  '.e2e-shots',
  '.design-verify',
  'aw-pack-verify',
  'docs/site/.vitepress/dist',
  'docs/site/.vitepress/cache',
]
// A 类文件:仓库根的散落产物
const A_FILES = [
  'agentworkshop-0.7.36.tgz',
  '.e2e-dev-restart.log',
  '.tmp-lint.json',
  'app-server-readme.md',
  'repo-exec.md',
]

// B 类:孤立测试脚本(无任何引用)
const usage = JSON.parse(readFileSync(join(ROOT, 'scripts/_audit/script-usage.json'), 'utf8'))
const B = usage.orphans.map(r => r.script)
// 例外白名单:即便孤立也保留(常备回归脚本 / 库 / 基础设施)
const KEEP_ALWAYS = new Set([
  'scripts/test-memory-month-query.mjs',
  'scripts/test-plugin-hardening.mjs',
  'scripts/_rtu-mini-slave.mjs',
])
const Bfinal = B.filter(p => !KEEP_ALWAYS.has(p))

// C 类:孤立调试脚本(scripts/_dbg-* 无引用)
const C = Bfinal.filter(p => /\/_dbg-/.test(p))

// D 类:scripts/_audit 下一次性命中类探针(无引用、非文档引用)
const D = Bfinal.filter(p => /\/_audit\//.test(p))

const groups = {
  A: [...A_DIRS.flatMap(d => walk(d)), ...A_FILES.filter(f => existsSync(join(ROOT, f.split('/').join(sep))))],
  B: Bfinal.filter(p => !C.includes(p) && !D.includes(p)),
  C,
  D,
}

const want = cls === 'ALL' ? ['A', 'B', 'C', 'D'] : [cls]
let total = 0
let totalBytes = 0
for (const k of want) {
  const list = groups[k]
  const bytes = size(list)
  total += list.length
  totalBytes += bytes
  console.log(`### ${k} 类: ${list.length} 项, ${(bytes / 1024 / 1024).toFixed(1)} MB`)
}
console.log(`总计 ${total} 项, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
console.log('')
for (const k of want) {
  console.log(`===== ${k} =====`)
  const list = groups[k].slice().sort()
  for (const p of list) console.log('  ' + p)
  console.log('')
}
