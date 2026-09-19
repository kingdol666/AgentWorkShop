// Verify locale files: parse, key parity, and every used t() key resolves in both locales.
import { readFileSync, readdirSync, statSync, copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// 1. Parse both locale files as ESM by copying to temp .mjs
const tmp = mkdtempSync(join(tmpdir(), 'aw-i18n-'))
const zhPath = join(tmp, 'zh.mjs')
const enPath = join(tmp, 'en.mjs')
copyFileSync('i18n/locales/zh-CN.ts', zhPath)
copyFileSync('i18n/locales/en.ts', enPath)

const zh = (await import(pathToFileURL(zhPath).href)).default
const en = (await import(pathToFileURL(enPath).href)).default

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? flat(v, p + k + '.') : [p + k]))
const zhKeys = new Set(flat(zh))
const enKeys = new Set(flat(en))
console.log('zh keys:', zhKeys.size, '/ en keys:', enKeys.size)
const missEn = [...zhKeys].filter(k => !enKeys.has(k))
const missZh = [...enKeys].filter(k => !zhKeys.has(k))
if (missEn.length) console.log('IN ZH MISSING EN:', missEn)
if (missZh.length) console.log('IN EN MISSING ZH:', missZh)

// 2. Every used t()/$t() key in app/ must exist in both
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}
const used = new Set()
const useRe = /(?:[.$]t|\bt)\(\s*['"]([a-zA-Z0-9_.]+)['"]/g
for (const f of walk('app')) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(useRe)) used.add(m[1])
}
const missing = [...used].filter(k => !zhKeys.has(k) || !enKeys.has(k))
console.log('used keys:', used.size, '/ unresolved:', missing.length)
if (missing.length) {
  console.log(missing.map((k) => {
    const inZh = zhKeys.has(k), inEn = enKeys.has(k)
    return `  ${k}  zh:${inZh ? 'Y' : 'N'} en:${inEn ? 'Y' : 'N'}`
  }).join('\n'))
}
console.log(missEn.length + missZh.length + missing.length === 0 ? 'PARITY OK' : 'PARITY FAIL')
