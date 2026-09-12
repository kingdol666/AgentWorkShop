// 删除后校验:确认没有任何"存活文件"仍引用被删除的脚本 / 截图
// 用法:node scripts/_audit/verify-cleanup.mjs
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = process.cwd()
const deleted = execSync('git status --porcelain', { cwd: ROOT, maxBuffer: 1 << 28 })
  .toString().split(/\r?\n/)
  .filter(l => /^ ?D /.test(l))
  .map(l => l.slice(3).replace(/\\/g, '/'))
  .filter(p => /\.(mjs|ts|cjs|js|py|sh|cmd)$/.test(p))

const SKIP = new Set(['node_modules', '.output', '.nuxt', '.git', '.mimosa', '.crush', '.agent-teams', 'paper', 'paper-show', '.zcode'])
function walk(rel, out = []) {
  const full = join(ROOT, rel.split('/').join(sep))
  if (!existsSync(full)) return out
  if (statSync(full).isFile()) { out.push(rel); return out }
  for (const n of readdirSync(full)) {
    if (SKIP.has(n)) continue
    walk(rel ? `${rel}/${n}` : n, out)
  }
  return out
}

const alive = walk('').filter(p =>
  /\.(mjs|ts|cjs|js|json|yml|yaml|md|vue|py|sh|cmd|rs|toml)$/.test(p)
  && !p.startsWith('docs/site/.vitepress/')
  && !p.startsWith('pnpm-lock')
  && !p.startsWith('.omc/')) // 已完成的会话计划草稿,非上游依赖

const deletedSet = new Set(deleted.map(p => p.split('/').pop()))
const bad = new Map()
for (const f of alive) {
  let text
  try { text = readFileSync(join(ROOT, f.split('/').join(sep)), 'utf8') } catch { continue }
  for (const d of deleted) {
    const base = d.split('/').pop()
    if (!deletedSet.has(base)) continue
    if (text.includes(base) || text.includes(d)) {
      if (!bad.has(d)) bad.set(d, [])
      bad.get(d).push(f)
    }
  }
}

console.log(`被删除脚本 ${deleted.length} 个`)
console.log(`仍有引用的 ${bad.size} 个:`)
for (const [d, refs] of bad) console.log(`  ${d}\n      <- ${refs.slice(0, 5).join(', ')}${refs.length > 5 ? ` (+${refs.length - 5})` : ''}`)

// 额外:检查 docs/**/*.md 里对截图的 markdown/HTML 引用是否还指向存在的文件
const mdFiles = alive.filter(p => p.endsWith('.md'))
const brokenImg = []
for (const f of mdFiles) {
  const text = readFileSync(join(ROOT, f.split('/').join(sep)), 'utf8')
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)|<img[^>]+src="([^"]+)"/g)) {
    const src = m[1] ?? m[2]
    if (!src || /^https?:/.test(src)) continue
    // 站点绝对路径(/xxx.png)由 docs/site/public 提供
    const target = src.startsWith('/')
      ? join(ROOT, 'docs/site/public', src.slice(1).split('/').join(sep))
      : join(ROOT, f.split('/').slice(0, -1).join(sep), src.split('/').join(sep))
    if (!existsSync(target)) brokenImg.push(`${f} -> ${src}`)
  }
}
console.log(`\ndocs 中失效图片引用: ${brokenImg.length}`)
for (const b of brokenImg.slice(0, 20)) console.log('  ' + b)
