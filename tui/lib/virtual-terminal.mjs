// ============================================================
// 虚拟终端(Terminal 接口最小实现)—— 无 TTY 环境驱动 TUI:
// 捕获写入帧、注入按键流;scripts/tui-smoke.mjs 无头 e2e 用。
// ============================================================
import { stripAnsi } from '../theme.mjs'

export class VirtualTerminal {
  constructor(cols = 120, rows = 34) {
    this.columns = cols
    this.rows = rows
    this.frames = []
    this.inputHandler = null
    this.kittyProtocolActive = false
  }

  start(onInput) {
    this.inputHandler = onInput
  }

  stop() {}
  async drainInput() {}
  write(data) {
    this.frames.push(data)
  }

  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}

  /** 测试注入按键(模拟 raw-mode 字节流) */
  emitInput(data) {
    this.inputHandler?.(data)
  }

  output() {
    return this.frames.join('')
  }

  /** 剥 ANSI 后的纯文本(断言用) */
  text() {
    return stripAnsi(this.output())
  }
}
