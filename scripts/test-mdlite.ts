/**
 * mdLite 围栏代码块单测:
 *  - 段落与代码块共存互不干扰;语言标签/复制按钮/正文转义保真
 *  - 未闭合围栏(流式中)安全渲染;行内代码不受影响
 * 运行:pnpm exec tsx scripts/test-mdlite.ts
 */
import { mdLite } from '../app/composables/workshop/useEventBlocks'

let failures = 0
const check = (name: string, ok: boolean): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures += 1
}

const out = mdLite('说明文字\n\n```ts\nconst a: number = 1\nconst b = 2\n```\n\n结尾段落')
check('代码块容器', out.includes('code-block'))
check('语言标签 ts', out.includes('data-lang="ts"'))
check('复制按钮', out.includes('code-copy'))
check('正文保真', out.includes('const a: number = 1'))
check('段落保留', out.includes('<p>说明文字</p>') && out.includes('<p>结尾段落</p>'))

const u = mdLite('流式中\n\n```js\nlet x = 1')
check('未闭合围栏(流式)', u.includes('data-lang="js"') && u.includes('let x = 1'))

const inline = mdLite('行内 `code` 与 **加粗**')
check('行内代码/加粗不受影响', inline.includes('<code>code</code>') && inline.includes('<b>加粗</b>'))

const multi = mdLite('```python\nprint(1)\n```\n\n中间段落\n\n```bash\necho hi\n```')
check('多代码块还原顺序', multi.indexOf('python') < multi.indexOf('中间段落') && multi.indexOf('中间段落') < multi.indexOf('echo hi'))

// ===== GitHub 提示框(`> [!NOTE]` 等;open-tag github-alert 移植) =====
const alert1 = mdLite('> [!NOTE]\n> 这是说明内容')
check('提示框-容器', alert1.includes('gh-alert') && alert1.includes('gh-note'))
check('提示框-标题', alert1.includes('gh-title') && alert1.includes('说明'))
check('提示框-正文', alert1.includes('这是说明内容'))
const alert2 = mdLite('> [!WARNING] 标题同行\n> 第二行')
check('提示框-同行标题', alert2.includes('gh-warning') && alert2.includes('标题同行') && alert2.includes('第二行'))
const alert3 = mdLite('> [!TIP]\n> 提示 A\n> 提示 B')
check('提示框-多行正文', alert3.includes('提示 A<br>提示 B'))
const bq = mdLite('> 普通引用不受影响')
check('普通引用保持', bq.includes('<blockquote>') && !bq.includes('gh-alert'))

// ===== 任务列表(`- [ ]` / `- [x]`;open-tag task-list 移植) =====
const tasks = mdLite('- [ ] 待办事项\n- [x] 已完成事项')
check('任务列表-容器', tasks.includes('task-list'))
check('任务列表-未完成', tasks.includes('<li class="task-item"><span class="task-check">'))
check('任务列表-勾选', tasks.includes('task-check on') && tasks.includes('✓'))
check('任务列表-完成态划线', tasks.includes('task-item done') && tasks.includes('已完成事项'))
const plain = mdLite('- 普通列表项')
check('普通列表保持', plain.includes('<ul>') && !plain.includes('task-list'))

console.log(failures === 0 ? '\n★ mdLite 代码块回归通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
