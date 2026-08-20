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

console.log(failures === 0 ? '\n★ mdLite 代码块回归通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
