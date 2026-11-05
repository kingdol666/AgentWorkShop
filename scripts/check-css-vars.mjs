/**
 * CSS 变量引用完整性校验 —— 扫描 app/ 下所有 .vue/.css 的 var(--x) 引用,
 * 对照全仓定义(--x: 出现即算定义,含组件 scoped 块与 JS setProperty)。
 * 未定义即非零退出。背景:--panel/--line-faint/--tone-warn-dot 等"幽灵令牌"
 * 曾在生产 CSS 裸奔(暗色主题白底白字/警示色静默回退),见
 * docs/plan/2026-11-06-ui-optimization-plan.md §3.1。
 *
 *   node scripts/check-css-vars.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(import.meta.dirname, '../app')

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(vue|css)$/.test(e.name)) yield p
  }
}

const files = [...walk(APP)]
const defined = new Set()
const used = new Map() // name -> [file:line]

// 定义面:样式声明(--x:)、JS setProperty('--x', 与模板 :style 对象键 '--x':
const RE_DECL = /--[\w-]+\s*:/g
const RE_JSINJ = /(['"])(--[\w-]+)\1\s*[,)]/g
const RE_OBJKEY = /(['"])(--[\w-]+)\1\s*:/g
// 引用面:var(--x 后必须紧跟名字终止符(逗号/右括号/空白),排除 var(--hud-*) 这类注释通配写法
const RE_USE = /var\(\s*(--[\w-]+)\s*[,)\s]/g

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const rel = path.relative(APP, f)
  for (const m of src.matchAll(RE_DECL)) defined.add(m[0].replace(/\s*:$/, ''))
  for (const m of src.matchAll(RE_JSINJ)) defined.add(m[2])
  for (const m of src.matchAll(RE_OBJKEY)) defined.add(m[2])
  let line = 1
  for (const seg of src.split('\n')) {
    for (const m of seg.matchAll(RE_USE)) {
      if (!used.has(m[1])) used.set(m[1], [])
      used.get(m[1]).push(`${rel}:${line}`)
    }
    line++
  }
}

const missing = [...used.keys()].filter(n => !defined.has(n)).sort()
if (missing.length) {
  console.error(`[check-css-vars] ${missing.length} 个未定义 CSS 变量被引用:`)
  for (const n of missing) {
    const where = used.get(n).slice(0, 3).join(', ')
    console.error(`  ${n}  <-  ${where}${used.get(n).length > 3 ? ` (+${used.get(n).length - 3})` : ''}`)
  }
  process.exit(1)
}
console.log(`[check-css-vars] OK — ${used.size} 个变量引用全部有定义(${files.length} 个文件)`)
