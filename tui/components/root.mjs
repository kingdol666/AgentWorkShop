// ============================================================
// Root —— 组件树组装:双栏(会话流 | 监控面板) + HITL 卡 + 状态条 + 编辑器。
// 双栏为手工列合成(pi-tui Container 只做纵向;列宽恒定防抖动)。
// 列宽计算必须用 CJK 感知的 visibleWidth(中文占 2 列;stripAnsi().length 会低估)。
// ============================================================
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui'
import { theme } from '../theme.mjs'

/**
 * 双栏容器:左栏自适应,右栏固定宽;任一为空退化为单栏。
 * left/right 需实现 render(width) → string[](Component duck-typing)。
 */
export class Columns {
  constructor(left, right = null, rightWidth = 46) {
    this.left = left
    this.right = right
    this.rightWidth = rightWidth
  }

  render(width) {
    const gutter = 3
    const leftWidth = this.right ? width - this.rightWidth - gutter : width
    const leftLines = this.left.render(leftWidth).map(l => truncateToWidth(l, leftWidth))
    if (!this.right || this.right.render === undefined) return leftLines
    const rightLines = this.right.render(this.rightWidth).map(l => truncateToWidth(l, this.rightWidth - 1))
    const height = Math.max(leftLines.length, rightLines.length)
    const out = []
    for (let i = 0; i < height; i++) {
      const l = leftLines[i] ?? ''
      const r = rightLines[i] ?? ''
      const padL = ' '.repeat(Math.max(leftWidth - visibleWidth(l), 0))
      out.push(`${l}${padL}${theme.faint(' │ ')}${r}`)
    }
    return out
  }
}

/** 组装整棵组件树(aw-tui 调用;返回可挂到 TUI 的顶层组件) */
export function buildTree({ state, chatLog, monitorPane, hitlCard, statusBar, editor }) {
  const columns = new Columns(chatLog, monitorPane)
  const stack = {
    render(width) {
      return [
        ...columns.render(width),
        ...hitlCard.render(width),
        ...statusBar.render(width),
      ]
    },
  }
  void state
  void editor
  return { stack, editor }
}
