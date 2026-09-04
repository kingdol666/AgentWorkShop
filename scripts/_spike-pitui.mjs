// Phase 0 spike:pi-tui(@earendil-works/pi-tui)无 TTY 可行性验证。
// 用虚拟终端(Terminal 接口最小实现)驱动真实 TUI 渲染 + Editor 输入,
// 全部断言通过 ⇒ 框架机制可用,交互层(真实终端 raw-mode/VT)由人工在
// Git Bash / Windows Terminal 各跑一次 `node scripts/_spike-pitui.mjs --live` 终验。
import { TuiMainScreen, Text, Editor, ProcessTerminal } from '@earendil-works/pi-tui'

const isLive = process.argv.includes('--live')

/** 虚拟终端:捕获写入、可注入输入(Terminal 接口最小 duck-typing 实现) */
class VirtualTerminal {
  constructor(cols = 100, rows = 30) {
    this.columns = cols
    this.rows = rows
    this.frames = []
    this.inputHandler = null
    this.kittyProtocolActive = false
  }

  start(onInput) { this.inputHandler = onInput }
  stop() {}
  async drainInput() {}
  write(data) { this.frames.push(data) }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  /** 测试注入按键(模拟 raw-mode 字节流) */
  emitInput(data) { this.inputHandler?.(data) }
  /** 全部输出拼接(strip ANSI 后可断言) */
  output() { return this.frames.join('') }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

// ---- 主题(与 tui/theme.mjs 同源的极简令牌;spike 内联验证结构) ----
const theme = {
  borderColor: s => `\x1b[38;2;53;224;160m${s}\x1b[0m`,
  selectList: {
    selectedPrefix: s => `› ${s}`,
    selectedText: s => `\x1b[38;2;65;200;244m${s}\x1b[0m`,
    description: s => `\x1b[2m${s}\x1b[0m`,
    scrollInfo: s => `\x1b[2m${s}\x1b[0m`,
    noMatch: s => s,
  },
}

let failures = 0
function check(name, cond) {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`)
  if (!cond) failures++
}

if (isLive) {
  // 真实终端交互验证:输入字符 + 回车;Ctrl+C 退出
  const tui = new TuiMainScreen(new ProcessTerminal())
  tui.addChild(new Text('pi-tui live spike: 输入任意文字后回车,Ctrl+C 退出'))
  const editor = new Editor(tui, theme)
  editor.onSubmit = text => tui.addChild(new Text(`[submit] ${text}`))
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()
  console.log('live spike running…')
}
else await (async () => {
// ---- headless 验证 ----
  console.log('[spike] pi-tui headless 渲染验证')
  const vt = new VirtualTerminal()
  const tui = new TuiMainScreen(vt)
  tui.addChild(new Text('AgentWorkShop TUI boot ok'))
  tui.addChild(new Text('频道: daq-产线A · 2 agents · HITL 待处理 1'))
  const editor = new Editor(tui, theme)
  const submitted = []
  editor.onSubmit = text => submitted.push(text)
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()
  await new Promise(r => setTimeout(r, 150))

  const out1 = stripAnsi(vt.output())
  check('TUI 实例化并启动(tui.start 无异常)', true)
  check('Text 组件渲染出现在输出帧', out1.includes('AgentWorkShop TUI boot ok'))
  check('中文与多行文本渲染', out1.includes('频道: daq-产线A'))
  check('Editor 边框渲染(borderColor 令牌生效)', vt.output().includes('\x1b[38;2;53;224;160m'))

  // Editor 输入:/help 回车 → onSubmit
  vt.frames.length = 0
  for (const ch of '/help') vt.emitInput(ch)
  await new Promise(r => setTimeout(r, 50))
  check('编辑器回显输入文本', stripAnsi(vt.output()).includes('/help'))
  vt.emitInput('\r')
  await new Promise(r => setTimeout(r, 50))
  check('回车触发 onSubmit', submitted.length === 1 && submitted[0] === '/help')

  // 光标移动 + 退格 + 历史(编辑器核心机制)
  vt.emitInput('abc')
  vt.emitInput('\x7f') // backspace
  check('退格删除字符', editor.getText() === 'ab')
  vt.emitInput('\x15') // Ctrl+U 清行
  check('Ctrl+U 清空输入行', editor.getText() === '')

  // 动态 addChild(流式追加语义)
  const before = stripAnsi(vt.output()).length
  tui.addChild(new Text('agent.delta 流块追加'))
  tui.requestRender(true)
  await new Promise(r => setTimeout(r, 80))
  check('动态 addChild + requestRender 增量渲染', stripAnsi(vt.output()).length > before && stripAnsi(vt.output()).includes('agent.delta 流块追加'))

  tui.stop()
  console.log(failures === 0 ? '\n[spike] GO —— pi-tui 机制全部可用(真实终端交互请另跑 --live 人工终验)' : `\n[spike] NO-GO —— ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
})()
