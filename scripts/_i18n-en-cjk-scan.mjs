// Scan en.ts (and zh-CN.ts) for values that still contain CJK — en must be CJK-free.
import { mkdtempSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'aw-i18n-'))
const load = async (p) => {
  const t = join(tmp, p.replace(/[^\w.-]/g, '_') + '.mjs')
  copyFileSync(p, t)
  return (await import(pathToFileURL(t).href)).default
}
const en = await load('i18n/locales/en.ts')
const zh = await load('i18n/locales/zh-CN.ts')

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/
function walk(o, prefix = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'object' && v !== null) walk(v, prefix + k + '.', out)
    else if (CJK.test(String(v))) out.push([prefix + k, String(v)])
  }
  return out
}
const enBad = walk(en)
console.log('en.ts CJK values:', enBad.length)
for (const [k, v] of enBad) console.log(`  ${k} = ${v.slice(0, 80)}`)
const zhBad = walk(zh)
console.log('zh-CN.ts CJK values (expected = all):', zhBad.length)
