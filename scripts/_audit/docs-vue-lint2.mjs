/**
 * docs-vue-lint2.mjs —— 用 VitePress 真实的 markdown 管线定位「Element is missing end tag」
 * ------------------------------------------------------------
 * 第一版(docs-vue-lint.mjs)只做逐行近似,漏掉了 markdown-it 才会做的转换
 * (自动链接、HTML 块、`~` 围栏、属性里的尖括号等)。这里改成:
 *   md --(vitepress createMarkdownRenderer)--> html --(@vue/compiler-dom)--> 报错
 * 再从 HTML 片段里回找源文件里对应的那一行。
 *
 * 用法:node scripts/_audit/docs-vue-lint2.mjs docs/site/plugins/guide.md
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SITE = join(ROOT, 'docs', 'site')

const { createMarkdownRenderer } = await import(pathToFileURL(join(SITE, 'node_modules', 'vitepress', 'dist', 'node', 'index.js')).href)
const { compile } = await import(pathToFileURL(join(SITE, 'node_modules', '@vue', 'compiler-dom', 'dist', 'compiler-dom.cjs.js')).href)

const md = await createMarkdownRenderer(SITE, {}, '/AgentWorkShop/')

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法:node scripts/_audit/docs-vue-lint2.mjs <markdown> [更多]')
  process.exit(2)
}

/** 从 HTML 里摘出「最像未闭合标签」的片段,用于回找源行 */
function suspects(html) {
  const out = new Set()
  const re = /<\/?([a-zA-Z][\w-]*)(\s[^>]*)?\/?>/g
  const KNOWN = new Set(['div', 'span', 'p', 'a', 'b', 'i', 'em', 'strong', 'code', 'pre', 'br', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'hr', 'details', 'summary', 'kbd', 'sub', 'sup', 'figure', 'figcaption', 'input', 'section', 'picture', 'source', 'video', 'small'])
  let m
  while ((m = re.exec(html)) !== null) {
    const tag = m[1]
    if (KNOWN.has(tag) || tag.includes('-')) continue
    out.add(m[0])
  }
  return [...out]
}

let failed = 0
for (const rel of files) {
  const p = resolve(ROOT, rel)
  if (!existsSync(p)) {
    console.log(`· ${rel} 不存在,跳过`)
    continue
  }
  const src = readFileSync(p, 'utf8')
  const html = md.render(src, { path: rel, relativePath: rel })
  let err = null
  try {
    compile(html, { onError: (e) => { throw e } })
  }
  catch (e) {
    err = e
  }
  if (!err) {
    console.log(`✔ ${rel} 真实管线可编译`)
    continue
  }
  failed++
  console.log(`✖ ${rel} → ${err.message}`)
  const list = suspects(html)
  if (!list.length) {
    console.log('     HTML 里没找到可疑自定义标签;可能是属性值/注释里的尖括号')
  }
  for (const s of list) {
    // 在源码里搜同一片段(可能被 markdown-it 原样透传)
    const srcLines = src.split('\n')
    const hit = srcLines.findIndex(l => l.includes(s))
    console.log(`     可疑: ${JSON.stringify(s)}  → 源文件第 ${hit === -1 ? '?' : hit + 1} 行`)
    if (hit >= 0) console.log(`         ${JSON.stringify(srcLines[hit].trim().slice(0, 140))}`)
  }
  // 若 HTML 里没有自定义标签,打印错误位置附近的 HTML 片段辅助定位
  if (!list.length) {
    const m = /\((\d+):(\d+)\)/.exec(err.message)
    if (m) {
      const lines = html.split('\n')
      const ln = Number(m[1])
      console.log(`     HTML 第 ${ln} 行附近:`)
      for (let i = Math.max(0, ln - 2); i < Math.min(lines.length, ln + 1); i++) {
        console.log(`       ${i + 1}| ${lines[i].slice(0, 160)}`)
      }
    }
  }
}

process.exit(failed ? 1 : 0)
