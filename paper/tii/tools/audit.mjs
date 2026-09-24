/**
 * tools/audit.mjs —— IEEE TII 投稿前自动化合规审计
 *
 * 逐轮评审共用同一套判据，避免"改完凭感觉说好了"。
 * 用法：node tools/audit.mjs            （审计论文目录）
 * 判据来源：IEEE TII 官方作者指南 + IES 页面（篇幅/摘要/关键词/图表/双盲）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', 'SUBMISSION-IEEE-TII')
if (!fs.existsSync(path.join(ROOT, 'main.tex'))) {
  console.error(`找不到论文目录：${ROOT}`)
  process.exit(2)
}
const SECTIONS = path.join(ROOT, 'sections')
const read = p => fs.readFileSync(p, 'utf8')
const texFiles = () => fs.readdirSync(SECTIONS).filter(f => f.endsWith('.tex'))
const allTex = () => texFiles().map(f => read(path.join(SECTIONS, f))).join('\n') + read(path.join(ROOT, 'main.tex'))
const words = s => s.replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}$\\~]/g, ' ').split(/\s+/).filter(Boolean).length

const results = []
const chk = (id, name, ok, detail) => results.push({ id, name, ok, detail })

// ── 1. 篇幅与开本（PDF 产物，用 pdfinfo 取权威值）────────────────────────────
const pdf = path.join(ROOT, 'main.pdf')
if (fs.existsSync(pdf)) {
  let info = ''
  try {
    info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' })
  }
  catch { /* pdfinfo 不可用时降级 */ }
  const pages = Number((info.match(/Pages:\s*(\d+)/i) ?? [])[1] ?? 0)
  const size = ((info.match(/Page size:\s*([^\n]+)/i) ?? [])[1] ?? '').trim()
  chk('F1', '初次投稿 ≤ 10 页', pages > 0 && pages <= 10, `${pages} 页`)
  chk('F2', 'Letter 开本', /612\s*x\s*792/.test(size), size || '未知')
  chk('F3', '无未解析引用（??）', (() => {
    try {
      const txt = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 })
      return !txt.includes('??')
    }
    catch { return false }
  })(), '正文中不应出现 ??')
}
else chk('F1', 'main.pdf 存在', false, '未找到编译产物')

// ── 2. 摘要与关键词 ─────────────────────────────
const mainTex = read(path.join(ROOT, 'main.tex'))
const absM = mainTex.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/)
if (absM) {
  const w = words(absM[1])
  chk('A1', '摘要 150–250 词', w >= 150 && w <= 250, `${w} 词`)
  chk('A2', '摘要无公式/引用', !/\\cite|\\ref|\\begin\{equation\}|\$[^$]+\$/.test(absM[1].replace(/\\rightarrow|\\approx/g, '')), '不应含 $…$ / \\cite / \\ref')
}
const kwM = mainTex.match(/\\begin\{IEEEkeywords\}([\s\S]*?)\\end\{IEEEkeywords\}/)
if (kwM) {
  const kws = kwM[1].trim().replace(/\.$/, '').split(',').map(s => s.trim()).filter(Boolean)
  chk('A3', '关键词 3–4 个', kws.length >= 3 && kws.length <= 4, `${kws.length} 个`)
  const sorted = [...kws].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  chk('A4', '关键词按字母序', JSON.stringify(kws) === JSON.stringify(sorted), kws.join(' / '))
}

// ── 3. 图表 ─────────────────────────────
const all = allTex()
const caps = [...all.matchAll(/\\caption\{([\s\S]*?)\n?\}/g)].map(m => m[1])
const over = caps.filter(c => words(c) > 200)
chk('G1', '图注 ≤200 词', over.length === 0, `${caps.length} 个题注，超长 ${over.length}`)
const figRefs = [...all.matchAll(/\\ref\{(fig:[^}]+)\}/g)].map(m => m[1])
const figLabels = new Set([...all.matchAll(/\\label\{(fig:[^}]+)\}/g)].map(m => m[1]))
chk('G2', '图引用均有对应 label', figRefs.every(r => figLabels.has(r)), [...new Set(figRefs)].join(', '))
const tabRefs = [...all.matchAll(/\\ref\{(tab:[^}]+)\}/g)].map(m => m[1])
const tabLabels = new Set([...all.matchAll(/\\label\{(tab:[^}]+)\}/g)].map(m => m[1]))
chk('G3', '表引用均有对应 label', tabRefs.every(r => tabLabels.has(r)), [...new Set(tabRefs)].join(', '))
const secRefs = [...all.matchAll(/\\ref\{(sec:[^}]+)\}/g)].map(m => m[1])
const secLabels = new Set([...all.matchAll(/\\label\{(sec:[^}]+)\}/g)].map(m => m[1]))
chk('G4', '节引用均有对应 label', secRefs.every(r => secLabels.has(r)), [...new Set(secRefs)].filter(r => !secLabels.has(r)).join(', ') || 'all ok')
// 图宽是否落在 IEEE 允许的栏宽/页宽区间
const widths = [...all.matchAll(/\\includegraphics\[width=([^\]]+)\]/g)].map(m => m[1])
const badW = widths.filter(w => !/\\textwidth|\\columnwidth|0\.\d+\\textwidth/.test(w))
chk('G5', '图宽为栏宽或页宽（或两者之间）', badW.length === 0, widths.join(' | '))

// ── 4. 引用完整性 ─────────────────────────────
const bib = read(path.join(ROOT, 'resources/refs.bib'))
const bibKeys = new Set([...bib.matchAll(/@[a-zA-Z]+\{([^,]+),/g)].map(m => m[1].trim()))
const cited = new Set()
for (const f of texFiles()) for (const m of read(path.join(SECTIONS, f)).matchAll(/\\cite\{([^}]+)\}/g)) m[1].split(',').forEach(k => cited.add(k.trim()))
const missing = [...cited].filter(k => !bibKeys.has(k))
chk('R1', '所有引用在 bib 中可解析', missing.length === 0, missing.join(', ') || `${cited.size} 条全部命中`)
const years = [...bib.matchAll(/@[a-zA-Z]+\{([^,]+),([\s\S]*?)\n\}/g)]
  .filter(m => cited.has(m[1].trim()))
  .map(m => Number((m[2].match(/year\s*=\s*[{"]?(\d{4})/i) ?? [])[1]))
  .filter(Boolean)
const recent = years.filter(y => 2026 - y <= 5).length
chk('R2', '近 5 年文献占比 >50%', recent / years.length > 0.5, `${recent}/${years.length} = ${Math.round(recent / years.length * 100)}%`)

// ── 5. 拼写一致性（TII 用美式）────────────────────────────
const BRIT = [/\bbehaviour/, /\banalyse\b/, /\bmodelling\b/, /\bneighbour/, /\bcolour/, /\blabelled\b/, /\bcentre\b/, /\bdefence\b/, /\borganis/, /\brecognis/, /\bstandardis/]
const britHits = BRIT.flatMap(re => (all.match(new RegExp(re.source, 'gi')) ?? []))
chk('S1', '拼写统一为美式（无英式残留）', britHits.length === 0, britHits.join(', ') || 'none')

// ── 6. 前部不得出现实测量化（本轮约定的写作纪律）────────────────────────────
const front = ['introduction', 'related', 'system', 'mechanisms']
  .map(f => read(path.join(SECTIONS, f + '.tex'))).join('\n')
const leak = [...front.matchAll(/\\res(?!WriteLock)[A-Z][a-zA-Z]*/g)].map(m => m[0])
chk('Q1', '前部（§I–§IV）无实测数值宏', leak.length === 0, leak.join(', ') || 'clean')

// ── 7. 结构完整性 ─────────────────────────────
for (const need of ['introduction', 'related', 'system', 'mechanisms', 'evaluation', 'discussion']) {
  chk('X-' + need, `章节 ${need}.tex 存在`, fs.existsSync(path.join(SECTIONS, need + '.tex')), '')
}
chk('X-input', 'main.tex 输入全部六章', ['introduction', 'related', 'system', 'mechanisms', 'evaluation', 'discussion'].every(s => mainTex.includes(`sections/${s}`)), '')

// ── 输出 ─────────────────────────────
const pass = results.filter(r => r.ok).length
console.log(`\n=== IEEE TII 合规审计 ===  ${pass}/${results.length} 通过\n`)
for (const r of results) {
  const mark = r.ok ? '✔' : '✘'
  console.log(`${mark} [${r.id}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
}
const fails = results.filter(r => !r.ok)
console.log(`\n${fails.length === 0 ? '✅ 全部通过' : '❌ 未通过 ' + fails.length + ' 项：' + fails.map(f => f.id).join(', ')}\n`)
process.exit(fails.length ? 1 : 0)
