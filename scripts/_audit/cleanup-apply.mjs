// 按引用索引执行清理(默认 dry-run,加 --apply 才真删)
// 口径:
//   A 生成产物 / 一次性走查截图 / scratch
//   B/C/D scripts/ 下零引用脚本(白名单与全功能测试手册用到的脚本一律排除)
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = process.cwd()
const APPLY = process.argv.includes('--apply')

function walk(rel, out = []) {
  const full = join(ROOT, rel.split('/').join(sep))
  if (!existsSync(full)) return out
  if (statSync(full).isFile()) { out.push(rel); return out }
  for (const n of readdirSync(full)) walk(`${rel}/${n}`, out)
  return out
}

// ---------- A 类:生成产物 / scratch ----------
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
const A_FILES = [
  'agentworkshop-0.7.36.tgz',
  '.e2e-dev-restart.log',
  '.tmp-lint.json',
  'app-server-readme.md',
  'repo-exec.md',
]

// ---------- B/C/D 类:零引用脚本 ----------
const usage = JSON.parse(readFileSync(join(ROOT, 'scripts/_audit/script-usage.json'), 'utf8'))
const KEEP_ALWAYS = new Set([
  'scripts/test-memory-month-query.mjs', // 常备回归(本轮验收全绿)
  'scripts/test-plugin-hardening.mjs', // 常备回归(本轮验收全绿)
  'scripts/_rtu-mini-slave.mjs', // 被协议矩阵等脚本 spawn 的夹具
])
const orphanScripts = usage.orphans.map(r => r.script).filter(p => !KEEP_ALWAYS.has(p))

// ---------- 安全闸:全功能测试手册里出现的路径必须全部保留 ----------
const plan = readFileSync(join(ROOT, 'docs/full-test-plan.md'), 'utf8')
const planPaths = [...plan.matchAll(/scripts\/[A-Za-z0-9_\-./]+\.(?:mjs|ts|cjs|py|sh)/g)].map(m => m[0])
const planSet = new Set(planPaths.map(p => p.replace(/\/+$/, '')))
const killed = orphanScripts.filter(p => planSet.has(p) || [...planSet].some(x => p.startsWith(x + '/')))
if (killed.length) {
  console.error('中止:以下脚本被 docs/full-test-plan.md 引用,不允许删除:')
  for (const k of killed) console.error('  ' + k)
  process.exitCode = 1
  throw new Error('safety gate')
}

// ---------- 执行 ----------
const dirsToRemove = A_DIRS.filter(d => existsSync(join(ROOT, d.split('/').join(sep))))
const filesToRemove = [
  ...A_FILES.filter(f => existsSync(join(ROOT, f.split('/').join(sep)))),
  ...orphanScripts.filter(p => existsSync(join(ROOT, p.split('/').join(sep)))),
]

const dirBytes = dirsToRemove.reduce((s, d) => s + walk(d).reduce((a, r) => {
  try { return a + statSync(join(ROOT, r.split('/').join(sep))).size } catch { return a }
}, 0), 0)
const fileBytes = filesToRemove.reduce((s, p) => {
  try { return s + statSync(join(ROOT, p.split('/').join(sep))).size } catch { return s }
}, 0)

const mb = bytes => bytes / 1048576 >= 1
  ? `${(bytes / 1048576).toFixed(1)} MB`
  : `${(bytes / 1024).toFixed(1)} KB`

console.log(`A 目录 ${dirsToRemove.length} 个(${mb(dirBytes)})`)
for (const d of dirsToRemove) console.log(`   - ${d}/  (${walk(d).length} 文件)`)
console.log(`文件 ${filesToRemove.length} 个(${mb(fileBytes)})`)
console.log(`  其中孤立脚本 ${orphanScripts.length} 个,散落产物 ${filesToRemove.length - orphanScripts.length} 个`)
console.log(`合计 ${mb(dirBytes + fileBytes)}`)
console.log(`docs/full-test-plan.md 引用脚本 ${planSet.size} 个 —— 全部保留`)

if (!APPLY) { console.log('\n[dry-run] 加 --apply 才真正删除'); process.exit(0) }

for (const d of dirsToRemove) rmSync(join(ROOT, d.split('/').join(sep)), { recursive: true, force: true })
let n = 0
for (const p of filesToRemove) { unlinkSync(join(ROOT, p.split('/').join(sep))); n++ }
console.log(`\n✔ 已删除 ${dirsToRemove.length} 个目录 + ${n} 个文件`)
