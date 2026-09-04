// ============================================================
// ChatLog 组件 —— 会话时间线(AEP 归约后的 log 行渲染)。
// 每次 render 全量输出(有界 400 行),增量绘制由 TuiMainScreen 差分完成。
// 输出经 truncateToWidth 兜底(CJK 宽字符行宽;pi-tui 对超宽行直接 crash)。
// ============================================================
import { theme } from '../theme.mjs'
import { wrapTextWithAnsi, truncateToWidth } from '@earendil-works/pi-tui'

const TONE_OF = {
  'system': s => theme.faint(s),
  'user': s => `${theme.info('◆ 你')} ${s}`,
  'agent': s => `${theme.accent('◆ Agent')} ${s}`,
  'stream': s => theme.faint(s),
  'task': s => theme.info(s),
  'hitl': s => theme.warn(s),
  'hitl-resolved': s => theme.accent(s),
  'error': s => theme.error(`✗ ${s}`),
  'notice': s => theme.faint(`· ${s}`),
  'monitor': s => s,
}

export class ChatLog {
  constructor(state) {
    this.state = state
  }

  render(width) {
    const w = Math.max(width, 20)
    const lines = []
    for (const row of this.state.log) {
      const paint = TONE_OF[row.kind] ?? (s => s)
      const prefix = row.kind === 'agent' && row.agentName ? `${theme.faint(`[${row.agentName}]`)} ` : ''
      const wrapped = wrapTextWithAnsi(paint(`${prefix}${row.text}`), w)
      lines.push(...wrapped)
    }
    if (this.state.statusMsg && Date.now() - this.state.statusAt < 15_000) {
      lines.push('')
      lines.push(theme.faint(this.state.statusMsg))
    }
    return lines.map(l => truncateToWidth(l, w))
  }
}
