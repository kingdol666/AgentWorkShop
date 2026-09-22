/**
 * UI 静态审计:交互元素未绑定动作扫描。
 * 扫 app/pages + app/components 全部 .vue,找「看起来可点但没有任何事件绑定」的
 * button / a-button / [role=button]。命中 = 潜在「UI 没绑动作」缺陷,逐条人工复核。
 * 运行: node scripts/_dbg-ui-static-audit.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['app/pages', 'app/components']
const SKIP = /node_modules|\.nuxt/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (SKIP.test(p)) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (e.endsWith('.vue')) out.push(p)
  }
  return out
}

// 事件绑定特征:vue 指令 @xxx / v-on:xxx(含修饰符),原生 onxxx 属性
const HAS_HANDLER = /(?:@|v-on:)[a-z]+(\.[a-z]+)*=|on(?:click|pointerdown|pointerup|touchstart|mousedown|keydown|change|input|update)\s*=/i
// 这些属性意味着元素可解释为无动作(装饰/纯展示)或由父级代管
const EXCUSED = /type\s*=\s*["'](submit|reset)["']|:disabled|disabled(?![a-z-])|aria-hidden|v-if|v-show|tag\s*=/

const findings = []
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    const rel = relative('.', file).replaceAll('\\\\', '/')
    // 匹配 <button ...> 与 <a-button ...> 开标签(跨行)
    const tagRe = /<(button|a-button|Button)\b([^>]*)>/gs
    let m
    while ((m = tagRe.exec(src))) {
      const attrs = m[2] ?? ''
      const line = src.slice(0, m.index).split('\n').length
      const hasHandler = HAS_HANDLER.test(attrs)
      // 包装组件代管:按钮作为 a-popconfirm / a-dropdown / a-tooltip 的触发插槽时,
      // 动作绑在包装层事件(confirm/open)上 —— 前缀中「开标签数 > 闭标签数」即仍在包装内
      const prefix = src.slice(0, m.index)
      const wrapped = ['a-popconfirm', 'a-dropdown', 'a-tooltip'].some((w) => {
        const opens = prefix.split(new RegExp(`<${w}\\b`, 'g')).length - 1
        const closes = prefix.split(new RegExp(`</${w}\\b`, 'g')).length - 1
        return opens > closes
      })
      const excused = EXCUSED.test(attrs)
      if (!hasHandler && !excused && !wrapped) {
        const snippet = attrs.replaceAll(/\s+/g, ' ').trim().slice(0, 120)
        findings.push({ file: rel, line, tag: m[1], snippet })
      }
    }
  }
}

console.log(`扫描完成:${ROOTS.join(' + ')} 下交互元素未绑定动作嫌疑 ${findings.length} 处`)
for (const f of findings) {
  console.log(`  [${f.tag}] ${f.file}:${f.line} — ${f.snippet}`)
}
if (findings.length === 0) console.log('✅ 无未绑定动作的按钮')
process.exitCode = findings.length > 0 ? 1 : 0
