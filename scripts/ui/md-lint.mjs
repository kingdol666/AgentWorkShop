/**
 * README 结构自检:标签配平、图片/链接存在、模板残留、表格列数一致。
 * GitHub 的渲染器很宽容,写坏了不报错 —— 只会在页面上难看,所以得自己查。
 */
import fs from 'node:fs'
import path from 'node:path'

const files = process.argv.slice(2)
const FENCE = String.fromCharCode(96).repeat(3)
let bad = 0
const fail = (f, m) => {
  bad += 1
  console.log('  x ' + f + ': ' + m)
}

for (const f of files) {
  const t = fs.readFileSync(f, 'utf8')
  const ls = t.split(/\r?\n/)
  console.log('·', f)

  // 转义残留:只把'转义了不该转义的字符'当问题(表格里的 \\| 是合法的)
  const esc = ls.findIndex(l => l.includes('\\' + String.fromCharCode(96)))
  if (esc >= 0) fail(f, 'line ' + (esc + 1) + ' 存在反引号转义残留')

  // ${...} 只在不处于围栏代码块里时才算未求值模板(shell 示例里的 ${VAR} 合法)
  {
    let fenced = false
    let hit = -1
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].trim().startsWith(FENCE)) {
        fenced = !fenced
        continue
      }
      if (!fenced && /\$\{[a-zA-Z_]/.test(ls[i])) {
        hit = i
        break
      }
    }
    if (hit >= 0) fail(f, 'line ' + (hit + 1) + ' 存在未求值的模板占位')
  }

  // 标签配平
  for (const tag of ['div', 'table', 'tr', 'td', 'details', 'summary', 'picture', 'sub', 'code', 'a']) {
    const open = (t.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length
    const close = (t.match(new RegExp('</' + tag + '>', 'g')) || []).length
    const self = (t.match(new RegExp('<' + tag + '[^>]*/>', 'g')) || []).length
    if (open - self !== close) fail(f, '<' + tag + '> 不配平: open=' + open + ' self=' + self + ' close=' + close)
  }

  // 本地图片 / 链接存在
  for (const m of t.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const src = m[1]
    if (/^https?:/.test(src)) continue
    const abs = path.resolve(path.dirname(f), src.replace(/^\.\//, ''))
    if (!fs.existsSync(abs)) fail(f, '图片不存在: ' + src)
  }
  for (const m of t.matchAll(/\]\((\.\/[^)#]+)\)/g)) {
    const abs = path.resolve(path.dirname(f), m[1].replace(/^\.\//, ''))
    if (!fs.existsSync(abs)) fail(f, '链接目标不存在: ' + m[1])
  }

  // 表格列数一致(转义管道符不算分隔)
  const cells = row => row.replace(/\\\|/g, '\u0000').split('|').length
  let cols = null, start = 0
  for (let i = 0; i <= ls.length; i++) {
    const isRow = i < ls.length && /^\s*\|.*\|\s*$/.test(ls[i])
    if (!isRow) {
      cols = null
      continue
    }
    const n = cells(ls[i])
    if (cols === null) {
      cols = n
      start = i
    }
    else if (n !== cols) fail(f, 'line ' + (i + 1) + ' 表格列数 ' + n + ' != 表头 ' + cols + '(表从 line ' + (start + 1) + ' 起)')
  }
}
console.log(bad ? '\n' + bad + ' 个问题' : '\n全部通过')
process.exit(bad ? 1 : 0)
