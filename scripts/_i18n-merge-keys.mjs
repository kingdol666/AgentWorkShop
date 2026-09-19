// Merge new i18n keys (zh + en) into i18n/locales/{zh-CN,en}.ts
// Usage: node scripts/_i18n-merge-keys.mjs <keys.json> [<keys2.json> ...]
import { readFileSync, writeFileSync } from 'node:fs'

const files = {
  'zh-CN': 'i18n/locales/zh-CN.ts',
  'en': 'i18n/locales/en.ts',
}
const zhIdx = 1, enIdx = 2 // tuple: [key, zh, en]

// TS single-quoted string escape + vue-i18n '@' literal interpolation
const ts = v => v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/@/g, '{\\\'@\\\'}')

const parts = process.argv.slice(2)
const entries = {}
for (const p of parts) {
  const data = JSON.parse(readFileSync(p, 'utf8'))
  for (const [ns, list] of Object.entries(data)) {
    (entries[ns] ??= []).push(...list)
  }
}

let inserted = 0, skipped = 0
for (const [loc, path] of Object.entries(files)) {
  let src = readFileSync(path, 'utf8')
  const vi = loc === 'zh-CN' ? zhIdx : enIdx
  for (const [ns, list] of Object.entries(entries)) {
    const re = new RegExp(`^  ${ns}: \\{$`, 'm')
    const m = re.exec(src)
    if (!m) {
      console.error(`NS NOT FOUND in ${loc}: ${ns}`)
      continue
    }
    const start = m.index + m[0].length
    const endRe = /^ {2}\},/m
    endRe.lastIndex = start
    const em = endRe.exec(src)
    const block = src.slice(start, em ? em.index : src.length)
    const lines = []
    for (const tuple of list) {
      const key = tuple[0]
      const val = tuple[vi]
      const keyRe = new RegExp(`^    ${key}: `, 'm')
      if (keyRe.test(block)) {
        skipped++
        continue
      }
      lines.push(`    ${key}: '${ts(val)}',`)
      inserted++
    }
    if (lines.length) {
      src = src.slice(0, start) + '\n' + lines.join('\n') + src.slice(start)
    }
  }
  writeFileSync(path, src)
  console.log(`OK ${loc}: +${inserted} skipped(existing) ${skipped}`)
  inserted = 0
  skipped = 0
}
