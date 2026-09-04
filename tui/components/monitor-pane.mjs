// ============================================================
// MonitorPane —— 右侧 agent 终端镜像面板(term 帧 → 行)。
// 行来源:aw-tui 的终端 WS 接线把 term.* 帧写入 state.monitor。
// ============================================================
import { theme } from '../theme.mjs'
import { wrapTextWithAnsi, truncateToWidth } from '@earendil-works/pi-tui'

const TONE = {
  dim: s => theme.faint(s),
  info: s => theme.info(s),
  warn: s => theme.warn(s),
  error: s => theme.error(s),
  accent: s => theme.accent(s),
  monitor: s => s,
}

export class MonitorPane {
  constructor(state, width = 44) {
    this.state = state
    this.width = width
  }

  render() {
    const m = this.state.monitor
    const w = Math.max(this.width - 2, 16)
    const head = theme.info(`┌─ 监控 ${m.name ?? m.agentId?.slice(0, 8) ?? ''} ${m.streaming ? '· 流式中' : ''}`)
    const lines = [head]
    if (m.waiting) lines.push(theme.warn('omp 进程未启动,等待首个任务…'))
    if (!m.agentId) lines.push(theme.faint('(未开启 —— /monitor <agent名|序号>)'))
    for (const l of m.lines) {
      const paint = TONE[l.tone] ?? (s => s)
      lines.push(...wrapTextWithAnsi(paint(l.text), w))
    }
    if (m.streamText) {
      lines.push(...wrapTextWithAnsi(theme.faint(m.streamText.slice(-600)), w))
    }
    return lines.slice(0, 200).map(l => truncateToWidth(l, w))
  }
}
