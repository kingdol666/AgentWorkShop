/**
 * i18n codemod:从 Vue SFC 提取中文 → 词条 dict,并替换为 t()/$t()。
 * 用法: node scripts/i18n-codemod.mjs <file.vue> <ns>
 * 输出: i18n/dicts/<ns>.json  (merge 模式,可重复运行)
 * 保守策略:
 *  - 模板文本节点(不含 {{}} 与标签的纯文本)
 *  - 未绑定属性 attr="中文"(值内禁 ' ? : = 防表达式误吞)
 *  - script 字符串字面量(整串 CJK 占比 ≥0.4;排除注释/import/反引号行/表达式特征)
 */
import fs from 'node:fs'
import path from 'node:path'

const CJK = /[\u4e00-\u9fff]/
const file = process.argv[2]
const ns = process.argv[3]
if (!file || !ns) {
  console.error('usage: node i18n-codemod.mjs <file.vue> <ns>')
  process.exit(1)
}

const dictPath = path.join('i18n/dicts', `${ns}.json`)
const dict = fs.existsSync(dictPath) ? JSON.parse(fs.readFileSync(dictPath, 'utf-8')) : {}
let keySeq = Object.keys(dict).length

const hashKey = (s) => {
  let h = 5381
  for (const ch of s) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0
  return `k${h.toString(36)}${String(++keySeq).padStart(3, '0')}`
}
const keyOf = (s) => {
  for (const [k, v] of Object.entries(dict)) if (v === s) return k
  const k = hashKey(s)
  dict[k] = s
  return k
}
/** 字面量安全性:CJK 占比达标且无代码特征 */
const literalOk = (s) => {
  if (/[${}?;=](?![^)]*\))/.test(s) && /===|filter\(|\.value|\$\{|\? /.test(s)) return false
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
  return cjk / s.length >= 0.35 && !/\$\{|===|filter\(|&&|\|\||=>/.test(s)
}

let src = fs.readFileSync(file, 'utf-8')
const count = { text: 0, attr: 0, script: 0 }

const tplStart = src.indexOf('<template>')
const tplEnd = src.lastIndexOf('</template>')
const scStart = src.indexOf('<script')
const scEnd = src.indexOf('</' + 'script>')
let tpl = src.slice(tplStart, tplEnd)
let script = scStart < tplStart
  ? src.slice(scStart, scEnd)
  : src.slice(scStart, scEnd)

// ── 1. 未绑定属性 attr="中文"(排除 :attr / @attr / 表达式特征) ──
const ATTRS = 'title|placeholder|aria-label|label|alt|content'
const attrRe = new RegExp(`(\\s)(${ATTRS})="([^"\\n]*)"`, 'g')
const tpl1 = tpl.replace(attrRe, (m, sp, attr, val) => {
  if (!CJK.test(val) || !literalOk(val)) return m
  count.attr++
  return `${sp}:${attr}="$t('${ns}.${keyOf(val.trim())}')"`
})

// ── 2. 模板文本节点 ──
const tpl2a = tpl1.replace(/>([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g, (m, text) => {
  const trimmed = text.trim()
  if (!trimmed || !literalOk(trimmed)) return m
  count.text++
  const replaced = text.replace(trimmed, `{{ $t('${ns}.${keyOf(trimmed)}') }}`)
  return `>${replaced}<`
})

// ── 2b. 混合节点:插值紧邻的中文段(前缀/后缀) ──
const tpl2b = tpl2a.replace(/>([^<>]*?)([\u4e00-\u9fff][^<>{}]*?)((?:\s*\{\{)|<)/g, (m, pre, cjk, tail) => {
  const trimmed = cjk.trim()
  if (!trimmed || !literalOk(trimmed)) return m
  count.text++
  return `>${pre}{{ $t('${ns}.${keyOf(trimmed)}') }}${tail}`
})
const tpl2c = tpl2b.replace(/((?:\}\})\s*)([\u4e00-\u9fff][^<>{}]*?)(\s*)(<|\n|$)/g, (m, pre, cjk, sp, tail) => {
  const trimmed = cjk.trim()
  if (!trimmed || !literalOk(trimmed)) return m
  count.text++
  return `${pre}{{ $t('${ns}.${keyOf(trimmed)}') }}${sp}${tail}`
})

// ── 2b2. 两个插值之间的中文段 ──
const tpl2c5 = tpl2c.replace(/\}\}([^<>{}]*[一-鿿][^<>{}]*?)\{\{/g, (m, mid) => {
  const trimmed = mid.trim()
  if (!trimmed || !literalOk(trimmed)) return m
  count.text++
  const replaced = mid.replace(trimmed, `{{ $t('${ns}.${keyOf(trimmed)}') }}`)
  return `}}${replaced}{{`
})

// ── 2c. 插值表达式内的中文引号串(三元等) ──
const tpl2d = tpl2c5.replace(/(\{\{[^}]*?)'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g, (m, head, val) => {
  if (!literalOk(val)) return m
  count.text++
  return `${head}$t('${ns}.${keyOf(val)}')`
})

// ── 2d. 反引号插值串参数化(前缀${x}后缀 → t('key', { p0: x }),消息 前缀{p0}后缀) ──
const BT_RE = new RegExp('`([^`\\n]*)`', 'g')
function backtickPass(text, call) {
  return text.replace(BT_RE, (m, content) => {
    if (!CJK.test(content)) return m
    const parts = content.split(/\$\{([^}]*)\}/)
    const msg = []
    const params = []
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) msg.push(parts[i])
      else {
        msg.push(`{p${params.length}}`)
        params.push(parts[i])
      }
    }
    const message = msg.join('')
    if (!CJK.test(message)) return m
    const key = keyOf(message)
    if (params.length === 0) return `${call}('${ns}.${key}')`
    return `${call}('${ns}.${key}', { ${params.map((pp, i) => `p${i}: ${pp.trim()}`).join(', ')} })`
  })
}

// ── 2e. 模板属性/插值中的反引号串($t) ──
const tpl2f = backtickPass(tpl2d, '$t')

// ── 3. script 字面量 ──
const lines = script.split('\n')
const out = []
for (const line of lines) {
  const trimmed = line.trim()
  const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
  if (isComment || !CJK.test(line) || line.includes('import ')) {
    out.push(line)
    continue
  }
  let nl = line.replace(/'([^'\\\n]*)'/g, (m2, val) => {
    if (!CJK.test(val) || !literalOk(val)) return m2
    count.script++
    return `t('${ns}.${keyOf(val)}')`
  })
  nl = nl.replace(/"([^"\\\n]*)"/g, (m2, val) => {
    if (!CJK.test(val) || !literalOk(val)) return m2
    count.script++
    return `t('${ns}.${keyOf(val)}')`
  })
  out.push(backtickPass(nl, 't'))
}
const script2 = out.join('\n')

// ── 4. 注入 useI18n ──
let script3 = script2
if (/\bt\('/.test(script2) && !/useI18n\(/.test(script2)) {
  const lastImport = script2.lastIndexOf('\nimport ')
  const insertAt = script2.indexOf('\n', lastImport + 1) + 1
  script3 = script2.slice(0, insertAt) + `const { t } = useI18n()\n` + script2.slice(insertAt)
}

// ── 组装 ──
if (scStart < tplStart) {
  const mid = src.slice(scEnd + 9, tplStart)
  src = script3 + '</' + 'script>' + mid + tpl2f + src.slice(tplEnd)
}
else {
  src = src.slice(0, tplStart) + tpl2f + src.slice(tplEnd, scStart) + script3 + src.slice(scEnd)
}

fs.mkdirSync('i18n/dicts', { recursive: true })
fs.writeFileSync(dictPath, JSON.stringify(dict, null, 2) + '\n')
fs.writeFileSync(file, src)
console.log(`${file} [${ns}] text:${count.text} attr:${count.attr} script:${count.script} dict:${Object.keys(dict).length}`)
