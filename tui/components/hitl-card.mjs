// ============================================================
// HitlCard —— 作答模式卡片(state.hitlAnswering 非空时渲染于输入框上方)。
// 作答约定:confirm → y/n;select → 选项序号;input/editor → 自由文本;
// /hitl off 放弃作答(等价 Esc)。提交经 POST /api/workshop/hitl/respond。
// ============================================================
import { theme } from '../theme.mjs'
import { wrapTextWithAnsi, truncateToWidth } from '@earendil-works/pi-tui'

const HINT = {
  confirm: '输入 y 批准 / n 拒绝',
  select: '输入选项序号(如 1)',
  input: '输入回答文本',
  editor: '输入回答文本',
}

const KIND_LABEL = {
  'omp-dialog': 'omp 对话框',
  'dcw-approval': '下发审批',
  'codex-approval': 'codex 审批',
  'opencode-permission': 'opencode 权限',
  'dsh-permission': 'dsh 权限',
}

export class HitlCard {
  constructor(state) {
    this.state = state
  }

  render(width) {
    const item = this.state.hitlAnswering
    if (!item) return []
    const w = Math.max(width - 4, 20)
    const lines = []
    lines.push(theme.warn(`⏸ HITL 作答 · ${item.agentName} · ${KIND_LABEL[item.kind] ?? '引擎待办'}`))
    lines.push(truncateToWidth(theme.bold(String(item.title ?? '')), w))
    if (item.detail) lines.push(...wrapTextWithAnsi(theme.faint(item.detail), w))
    if (item.message) lines.push(...wrapTextWithAnsi(String(item.message), w))
    if (item.method === 'select' && Array.isArray(item.options)) {
      item.options.forEach((opt, i) => lines.push(`  ${theme.accent(`${i + 1}.`)} ${opt}`))
    }
    // 下发审批(dcw-approval)无 method 字段,必须显式告知 y/n 约定,
    // 否则中文确认词会触发"非 y 即拒绝"的静默拒绝。
    const hint = item.kind === 'omp-dialog' ? (HINT[item.method] ?? '输入回答') : '输入 y 批准 / n 拒绝'
    lines.push(theme.faint(`${hint} · /hitl off 放弃`))
    return lines.map(l => truncateToWidth(l, Math.max(width, 20)))
  }
}
