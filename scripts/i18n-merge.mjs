/**
 * 合并器:把 i18n/dicts/<ns>.json(zh)+ i18n/dicts/_en.json(zh→en)
 * 注入 i18n/locales/zh-CN.ts 与 en.ts。
 * - ns 已存在 → 在其块首插入缺词条;否则新建 ns 块
 * - vue-i18n 特殊字符({}@$|)转义为字面量插值
 * - en 缺失 → 回退 zh(报告计数)
 */
import fs from 'node:fs'
import path from 'node:path'

const esc = v => v
  // 保护 vue-i18n 占位符 {pN},其余 { } @ | $ 转义为字面量插值
  .replace(/\{(?!p\d+\})/g, '{\'{\'}')
  .replace(/([@$|])/g, '{\'$1\'}')
const enMap = JSON.parse(fs.readFileSync('i18n/dicts/_en.json', 'utf-8'))
let miss = 0

function buildEntries(ns, dict, isEn) {
  const out = []
  for (const [k, zh] of Object.entries(dict)) {
    let v = zh
    if (isEn) {
      const normalized = s => s.replace(/\s+/g, ' ').trim()
      const hit = enMap[normalized(zh)] ?? enMap[zh]
      if (hit == null) {
        miss++
        v = zh
      }
      else v = hit
    }
    out.push(`    ${k}: '${esc(v).replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\r?\n/g, '\\n')}',`)
  }
  return out
}

for (const [localeFile, isEn] of [['i18n/locales/zh-CN.ts', false], ['i18n/locales/en.ts', true]]) {
  let src = fs.readFileSync(localeFile, 'utf-8')
  let insertedTotal = 0
  for (const f of fs.readdirSync('i18n/dicts').filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
    const ns = f.replace('.json', '')
    const dict = JSON.parse(fs.readFileSync(path.join('i18n/dicts', f), 'utf-8'))
    const entries = buildEntries(ns, dict, isEn)
    if (entries.length === 0) continue
    const nsRe = new RegExp(`^  ${ns}: \\{`, 'm')
    const m = src.match(nsRe)
    if (m) {
      // 已有 ns:块首插入尚不存在的键
      const start = m.index + m[0].length
      const end = src.indexOf('\n  },', start)
      const block = src.slice(start, end)
      const fresh = entries.filter(e => !block.includes(e.match(/ {4}(\w+):/)[1] + ':'))
      if (fresh.length) {
        src = src.slice(0, start) + '\n' + fresh.join('\n') + src.slice(start)
        insertedTotal += fresh.length
      }
    }
    else {
      // 新 ns:插到文件末尾闭合前
      const tail = src.lastIndexOf('}')
      const block = `  ${ns}: {\n${entries.join('\n')}\n  },\n`
      src = src.slice(0, tail) + block + src.slice(tail)
      insertedTotal += entries.length
    }
  }
  fs.writeFileSync(localeFile, src)
  console.log(`${localeFile}: +${insertedTotal} entries (en missing fallback: ${isEn ? miss : 'n/a'})`)
}
