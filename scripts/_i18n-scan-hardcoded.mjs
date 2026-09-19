// Scan .vue/.ts files for hardcoded Chinese text that renders in UI (not comments).
// v3: single-pass state machine masks comments (// /* */ <!-- -->) while preserving strings.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = [join(process.cwd(), 'app')]
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.vue') || name.endsWith('.ts')) out.push(p)
  }
  return out
}

// Mask comments with spaces, keep newlines, keep string literals intact.
function maskComments(src) {
  const out = src.split('')
  let i = 0
  const n = src.length
  let state = 'code' // code | line | block | html | squote | dquote | backtick
  const set = (from, to) => {
    for (let k = from; k < to; k++) {
      if (src[k] !== '\n') out[k] = ' '
    }
  }
  const skipLineComment = () => {
    const j = src.indexOf('\n', i)
    const e = j === -1 ? n : j
    set(i, e)
    i = e
  }
  const skipTo = (needle, from, pad) => {
    const j = src.indexOf(needle, from)
    const e = j === -1 ? n : j + pad
    set(i, e)
    i = e
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') {
        skipLineComment()
        continue
      }
      if (c === '/' && d === '*') {
        skipTo('*/', i + 2, 2)
        state = 'code'
        continue
      }
      if (c === '<' && d === '!' && src.slice(i, i + 4) === '<!--') {
        skipTo('-->', i + 4, 3)
        continue
      }
      if (c === '\'') {
        state = 'squote'
        i++
        continue
      }
      if (c === '"') {
        state = 'dquote'
        i++
        continue
      }
      if (c === '`') {
        state = 'backtick'
        i++
        continue
      }
      i++
      continue
    }
    if (state === 'line') {
      i = src.indexOf('\n', i)
      if (i === -1) i = n
      state = 'code'
      continue
    }
    if (state === 'block') {
      const j = src.indexOf('*/', i)
      if (j === -1) {
        i = n
      }
      else {
        i = j + 2
        state = 'code'
      }
      continue
    }
    if (state === 'html') {
      const j = src.indexOf('-->', i)
      if (j === -1) {
        i = n
      }
      else {
        i = j + 3
        state = 'code'
      }
      continue
    }
    // strings: skip escaped chars, exit on close quote (no comment masking inside strings)
    if (state === 'squote' || state === 'dquote') {
      if (c === '\\') {
        i += 2
        continue
      }
      if ((state === 'squote' && c === '\'') || (state === 'dquote' && c === '"')) state = 'code'
      i++
      continue
    }
    if (state === 'backtick') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') state = 'code'
      i++
      continue
    }
  }
  return out.join('')
}

const results = []
for (const ROOT of ROOTS) {
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, 'utf8')
    const masked = maskComments(src)
    const lines = masked.split('\n')
    const origLines = src.split('\n')
    const rel = relative(process.cwd(), file).replace(/\\/g, '/')

    const templateStart = masked.indexOf('<template')
    const templateEnd = masked.lastIndexOf('</template>')
    const scriptMatch = /<script[^>]*>/.exec(masked)
    const scriptStart = scriptMatch ? scriptMatch.index : -1
    const scriptEnd = masked.lastIndexOf('</script>')

    const charStartOf = (lineIdx0) => {
      let acc = 0
      for (let i = 0; i < lineIdx0; i++) acc += lines[i].length + 1
      return acc
    }

    const findings = []
    lines.forEach((line, i) => {
      if (!CJK.test(line)) return
      const charStart = charStartOf(i)
      let cat
      if (templateStart >= 0 && charStart >= templateStart && charStart <= templateEnd + 11) {
        const withoutT = line.replace(/\{\{\s*[^{}]*?\}\}/g, m => (/\$?t\s*\(/.test(m) && !CJK.test(m.replace(/\$?t\s*\([^)]*\)/g, '')) ? '' : m))
        if (!CJK.test(withoutT)) return
        cat = /[a-zA-Z-]+\s*=\s*"[^"]*[\u4e00-\u9fff]/.test(line) ? 'template-attr' : 'template-text'
      }
      else if (scriptStart >= 0 && charStart >= scriptStart && charStart <= scriptEnd + 9) {
        const withoutT = line.replace(/\b(?:t|tt|\$t|i18n\.t)\(\s*['"`][^'"`]*['"`][^)]*\)/g, '')
        if (!CJK.test(withoutT)) return
        cat = 'script-literal'
      }
      else {
        return
      }
      findings.push({ line: i + 1, cat, text: origLines[i].trim().slice(0, 200) })
    })

    if (findings.length) results.push({ file: rel, findings })
  }
}

let total = 0
for (const r of results) {
  total += r.findings.length
  console.log(`\n=== ${r.file} (${r.findings.length}) ===`)
  for (const f of r.findings) console.log(`  L${f.line} [${f.cat}] ${f.text}`)
}
console.log(`\n\nTOTAL suspect lines: ${total} in ${results.length} files`)
