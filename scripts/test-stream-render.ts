/**
 * 流块渲染语义回归(Node 级,纯函数直测):
 *  - streamCursorVisible:空光标闪烁修复的权威语义(空文本绝不显示光标)
 *  - mdLite:散文渲染(段落/标题/列表/引用/行内代码/加粗/转义安全)
 * 运行:pnpm exec tsx scripts/test-stream-render.ts
 */
import { streamCursorVisible, mdLite, escapeHtml } from '../app/composables/workshop/useEventBlocks'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

console.log('光标可见性(空光标修复)')
check('空文本 × 流式中 → 不显示(杜绝空光标闪烁)', streamCursorVisible(0, 0, true) === false)
check('有文本 × 流式中 → 显示(打字机跟随)', streamCursorVisible(10, 4, true) === true)
check('有文本 × 流式中 × 已追平 → 显示(光标在文末等待下一段)', streamCursorVisible(10, 10, true) === true)
check('有文本 × 已落定 × 已追平 → 不显示', streamCursorVisible(10, 10, false) === false)
check('有文本 × 已落定 × 未追平(rAF 追赶中)→ 显示', streamCursorVisible(10, 6, false) === true)
check('空文本 × 已落定 → 不显示', streamCursorVisible(0, 0, false) === false)

console.log('mdLite 散文渲染')
check('纯段落 → <p>', mdLite('hello world') === '<p>hello world</p>')
check('## 标题 → <h4>', mdLite('## Title') === '<h4>Title</h4>')
check('无序列表 → <ul><li>', mdLite('- a\n- b') === '<ul><li>a</li><li>b</li></ul>')
check('行内代码 → <code>', mdLite('use `xterm` here').includes('<code>xterm</code>'))
check('加粗 → <b>', mdLite('**bold** text').includes('<b>bold</b>'))
check('引用块 → <blockquote>', mdLite('> quoted').includes('<blockquote>quoted</blockquote>'))
check('HTML 注入被转义(流式安全)', mdLite('<script>alert(1)</script>').includes('&lt;script&gt;') && !mdLite('<img src=x onerror=1>').includes('<img'))
check('空行分段 → 两个 <p>', mdLite('a\n\nb') === '<p>a</p><p>b</p>')
check('单换行 → <br>', mdLite('a\nb') === '<p>a<br>b</p>')
check('部分流式文本安全(未闭合标记原样呈现)', mdLite('```js\nconst x').includes('<p>') || mdLite('```js\nconst x').includes('<code>'))
check('escapeHtml 基本转义', escapeHtml('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')

console.log(failures === 0 ? '\n★ 流块渲染语义回归通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
