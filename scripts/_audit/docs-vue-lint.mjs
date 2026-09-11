/**
 * docs-vue-lint.mjs —— 找出 VitePress「Element is missing end tag」的真实来源行
 * ------------------------------------------------------------
 * VitePress 报的行列号是**生成代码**里的位置,对不上源文件,人工排查很费时。
 * 这里改用逐行二分:把 markdown 的正文按行累加交给 @vue/compiler-dom 编译,
 * 第一次编译失败的那一行就是罪魁。行内代码/围栏代码先剥掉(markdown-it 会转义它们)。
 *
 * 用法:node scripts/_audit/docs-vue-lint.mjs docs/site/plugins/guide.md [更多文件...]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const compilerEntry = join(ROOT, 'docs', 'site', 'node_modules', '@vue', 'compiler-dom', 'dist', 'compiler-dom.cjs.js')
if (!existsSync(compilerEntry)) {
  console.error('✖ 未找到 @vue/compiler-dom(需先 cd docs/site && npm i)')
  process.exit(2)
}
const { compile } = await import(pathToFileURL(compilerEntry).href)

/** 粗略还原 markdown-it 的输出:去掉围栏与行内代码,保留其余原样 */
function toTemplateSource(md) {
  const noFm = md.replace(/^---\n[\s\S]*?\n---\n/, '')
  const out = []
  let inFence = false
  for (const line of noFm.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push('')
      continue
    }
    if (inFence) {
      out.push('')
      continue
    }
    // 行内代码 → 替换为等长占位,保持列号大致可用
    out.push(line.replace(/`[^`\n]*`/g, m => 'x'.repeat(m.length)))
  }
  return out
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法:node scripts/_audit/docs-vue-lint.mjs <markdown> [更多]')
  process.exit(2)
}

let bad = 0
for (const rel of files) {
  const p = resolve(ROOT, rel)
  if (!existsSync(p)) {
    console.log(`· ${rel} 不存在,跳过`)
    continue
  }
  const lines = toTemplateSource(readFileSync(p, 'utf8'))
  let firstBad = -1
  let message = ''
  for (let i = 1; i <= lines.length; i++) {
    const chunk = lines.slice(0, i).join('\n')
    try {
      compile(chunk, { onError: (e) => { throw e } })
    }
    catch (err) {
      firstBad = i
      message = err?.message ?? String(err)
      break
    }
  }
  if (firstBad === -1) {
    console.log(`✔ ${rel} 模板可编译(${lines.length} 行)`)
    continue
  }
  bad++
  console.log(`✖ ${rel}:${firstBad} → ${message}`)
  console.log(`     ${JSON.stringify(lines[firstBad - 1].slice(0, 160))}`)
}

process.exit(bad ? 1 : 0)
