/**
 * 临时:把 ESLint `@stylistic/max-statements-per-line` 命中的单行多语句**按项目风格重排**。
 *  ① 由 eslint 自己给出精确行号(不猜);
 *  ② 块形态 `head { A; B }` → 展开为多行;`head { A }`(单语句)同样展开(该规则把
 *     函数/if 声明与体内语句算作同一行两条);
 *  ③ 非块形态 `const a = []; const b = new Set()` → 按顶层 `; ` 拆行;
 *  ④ 处理完用 eslint + tsc 复验(eslint 是唯一裁判,转错会留下错误)。
 * 用法:node scripts/_lint-reflow.mjs <file...>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) throw new Error('用法:node scripts/_lint-reflow.mjs <file...>')

/** 顶层分号切分(这些行里不含字符串内分号与嵌套块,足够安全;切错会被 eslint/tsc 挡下) */
function splitTop(value) {
  const out = []
  let depth = 0
  let cur = ''
  let quote = ''
  for (const ch of value) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    if (ch === ';' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

function expandLine(line) {
  const indent = /^\s*/.exec(line)[0]
  const body = line.slice(indent.length)
  // 块形态:最后一个 '{' 与最后一个 '}' 之间是块体
  const open = body.lastIndexOf('{')
  const close = body.lastIndexOf('}')
  if (open >= 0 && close > open) {
    const head = body.slice(0, open + 1).trimEnd()
    const inner = body.slice(open + 1, close).trim()
    const tail = body.slice(close + 1).trim()
    const stmts = splitTop(inner)
    if (stmts.length === 0) return null
    return [
      `${indent}${head}`,
      ...stmts.map(s => `${indent}  ${s}`),
      `${indent}}${tail ? ` ${tail}` : ''}`,
    ]
  }
  const stmts = splitTop(body)
  if (stmts.length < 2) return null
  return stmts.map(s => `${indent}${s}`)
}

/** eslint 有错误时退出码非 0 → 必须从 error.stdout 取报告,否则 execFileSync 直接抛 */
function eslintReport(file) {
  try {
    return JSON.parse(execFileSync('npx', ['eslint', file, '-f', 'json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }))
  }
  catch (err) {
    const out = String(err?.stdout ?? '')
    if (!out.trim()) throw err
    return JSON.parse(out)
  }
}

for (const file of files) {
  let report = eslintReport(file)
  let source = readFileSync(file, 'utf8')
  let guard = 0
  while (report[0]?.messages?.length && guard < 12) {
    guard += 1
    const targets = [...new Set(report[0].messages.filter(m => m.ruleId === '@stylistic/max-statements-per-line').map(m => m.line))]
    if (targets.length === 0) break
    const lines = source.split('\n')
    let changed = 0
    for (const n of targets.sort((a, b) => b - a)) {
      const expanded = expandLine(lines[n - 1])
      if (expanded && expanded.length > 1) {
        lines.splice(n - 1, 1, ...expanded)
        changed += 1
      }
    }
    if (changed === 0) break
    source = lines.join('\n')
    writeFileSync(file, source, 'utf8')
    report = eslintReport(file)
  }
  const left = report[0]?.messages ?? []
  console.log(`${file}: 剩余 ${left.length} 条${left.length ? ` → ${left.slice(0, 4).map(m => `${m.line}:${m.ruleId}`).join(', ')}` : ' ✔'}`)
}
