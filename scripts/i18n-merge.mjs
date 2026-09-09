/**
 * 合并器:把 i18n/dicts/<ns>.json(zh)+ i18n/dicts/_en.json(zh→en)
 * 注入 i18n/locales/zh-CN.ts 与 en.ts。
 * - dict 中的点号键('src.user'、'runtime.daq.x')展开为嵌套对象输出,
 *   与 vue-i18n 的路径解析语义一致(resolveValue 按 '.' 分段逐层下钻)
 * - ns 已存在 → 解析块内叶子路径,补插缺失键(整块重建,保持既有条目)
 * - vue-i18n 特殊字符({}@$|)转义为字面量插值;{pN} 占位符保持原样
 * - en 缺失 → 回退 zh(报告计数)
 * - 键风格:合法标识符用裸键,其余用单引号(项目 eslint singlequote 风格)
 */
import fs from 'node:fs'
import path from 'node:path'

const esc = v => v
  .replace(/\{(?!p\d+\})/g, `{'{'}`)
  .replace(/([@$|])/g, `{'$1'}`)
const enMap = JSON.parse(fs.readFileSync('i18n/dicts/_en.json', 'utf-8'))
let miss = 0
const norm = s => s.replace(/\s+/g, ' ').trim()

function valueFor(zh, isEn) {
  if (!isEn) return zh
  const hit = enMap[norm(zh)] ?? enMap[zh]
  if (hit == null) {
    miss++
    return zh
  }
  return hit
}

function quoteKey(k) {
  return /^[A-Za-z0-9_$]+$/.test(k) ? k : `'${k.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
}
function quoteVal(v) {
  return `'${esc(v).replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\r?\n/g, '\\n')}'`
}

// dict → 树:点号键展开为嵌套分组
function toTree(dict, isEn) {
  const root = { entries: [], groups: new Map() }
  for (const [k, zh] of Object.entries(dict)) {
    const v = valueFor(zh, isEn)
    const segs = k.split('.')
    let node = root
    for (let i = 0; i < segs.length - 1; i++) {
      let g = node.groups.get(segs[i])
      if (!g) {
        g = { entries: [], groups: new Map() }
        node.groups.set(segs[i], g)
      }
      node = g
    }
    // 同名键不重复插入;值在建树时统一引用化,emit 阶段只写原始字面量
    if (!node.entries.some(e => e[0] === segs[segs.length - 1])) {
      node.entries.push([segs[segs.length - 1], quoteVal(v)])
    }
  }
  return root
}

function emitTree(tree, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [k, v] of tree.entries) lines.push(`${pad}${quoteKey(k)}: ${v},`)
  for (const [k, g] of tree.groups) {
    lines.push(`${pad}${quoteKey(k)}: {`)
    lines.push(...emitTree(g, indent + 2))
    lines.push(`${pad}},`)
  }
  return lines
}

// 解析既有 ns 块 → 有序树(值为已引用的原始字面量,保持原样)
// 返回 { tree, hadDottedEntry }:块内还存在扁平点号键时标记需重建
function parseBlockTree(lines) {
  const mk = () => ({ entries: [], groups: new Map() })
  const root = mk()
  const stack = [{ indent: 0, node: root }]
  let hadDottedEntry = false
  for (const raw of lines) {
    const indent = (raw.match(/^ */) || [''])[0].length - 4
    const ln = raw.trim()
    const closeM = ln.match(/^\},?$/)
    if (closeM) {
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
      continue
    }
    const openM = ln.match(/^(?:"([^"]+)"|'([^']+)'|([\w$]+)): \{$/)
    const entryM = ln.match(/^(?:"([^"]+)"|'([^']+)'|([\w$]+)): (.*)$/)
    if (openM) {
      const name = openM[1] ?? openM[2] ?? openM[3]
      let g = stack[stack.length - 1].node.groups.get(name)
      if (!g) {
        g = mk()
        stack[stack.length - 1].node.groups.set(name, g)
      }
      stack.push({ indent, node: g })
    }
    else if (entryM) {
      const name = entryM[1] ?? entryM[2] ?? entryM[3]
      // 去掉行尾逗号,保留已引用的字面量原样
      const val = entryM[4].replace(/,\s*$/, '')
      const node = stack[stack.length - 1].node
      if (name.includes('.')) {
        // 旧版扁平点号键:展开为嵌套,记为重建信号
        hadDottedEntry = true
        const segs = name.split('.')
        let cur = node
        for (let i = 0; i < segs.length - 1; i++) {
          let g = cur.groups.get(segs[i])
          if (!g) {
            g = mk()
            cur.groups.set(segs[i], g)
          }
          cur = g
        }
        if (!cur.entries.some(e => e[0] === segs[segs.length - 1])) cur.entries.push([segs[segs.length - 1], val])
      }
      else {
        if (!node.entries.some(e => e[0] === name)) node.entries.push([name, val])
      }
    }
  }
  return { tree: root, hadDottedEntry }
}

// 树的全部叶子路径
function treeLeaves(tree, prefix = '') {
  const out = new Set()
  for (const [k] of tree.entries) out.add(prefix ? `${prefix}.${k}` : k)
  for (const [k, g] of tree.groups) for (const p of treeLeaves(g, prefix ? `${prefix}.${k}` : k)) out.add(p)
  return out
}

// 合并 dict 树缺失叶子到既有树(两侧值均为已引用化字面量)
function mergeTree(existing, dictTree) {
  let added = 0
  for (const [k, v] of dictTree.entries) {
    if (!existing.entries.some(e => e[0] === k)) {
      existing.entries.push([k, v])
      added++
    }
  }
  for (const [k, g] of dictTree.groups) {
    let sub = existing.groups.get(k)
    if (!sub) {
      sub = { entries: [], groups: new Map() }
      existing.groups.set(k, sub)
    }
    added += mergeTree(sub, g)
  }
  return added
}

for (const [localeFile, isEn] of [['i18n/locales/zh-CN.ts', false], ['i18n/locales/en.ts', true]]) {
  let src = fs.readFileSync(localeFile, 'utf-8')
  let insertedTotal = 0
  for (const f of fs.readdirSync('i18n/dicts').filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
    const ns = f.replace('.json', '')
    const dict = JSON.parse(fs.readFileSync(path.join('i18n/dicts', f), 'utf-8'))
    if (Object.keys(dict).length === 0) continue
    const dictTree = toTree(dict, isEn)
    const nsRe = new RegExp(`^  (?:${JSON.stringify(ns)}|'${ns}'|${ns}): \\{`, 'm')
    const m = src.match(nsRe)
    if (m) {
      // 已有 ns:解析块 → 检查叶子 → 有缺失或存在旧扁平点号键时整块重建
      const start = m.index + m[0].length
      const end = src.indexOf('\n  },', start)
      const blockLines = src.slice(start, end).split('\n').filter(l => l.trim() !== '')
      const { tree: existingTree, hadDottedEntry } = parseBlockTree(blockLines)
      const existingLeaves = treeLeaves(existingTree)
      const wantLeaves = treeLeaves(dictTree)
      const missing = [...wantLeaves].filter(l => !existingLeaves.has(l)).length
      if (missing > 0 || hadDottedEntry) {
        const added = mergeTree(existingTree, dictTree, isEn)
        const rebuilt = [''].concat(emitTree(existingTree, 4))
        src = src.slice(0, start) + rebuilt.join('\n') + src.slice(end)
        insertedTotal += added
      }
    }
    else {
      // 新 ns:插到文件末尾闭合前(ns 名非合法标识符时加引号,如 team-plugins)
      const tail = src.lastIndexOf('}')
      const block = `  ${quoteKey(ns)}: {\n${emitTree(dictTree, 4).join('\n')}\n  },\n`
      src = src.slice(0, tail) + block + src.slice(tail)
      insertedTotal += treeLeaves(dictTree).size
    }
  }
  fs.writeFileSync(localeFile, src)
  console.log(`${localeFile}: +${insertedTotal} entries (en missing fallback: ${isEn ? miss : 'n/a'})`)
}
