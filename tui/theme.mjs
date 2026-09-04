// ============================================================
// TUI 主题 —— 控制室宪法令牌(WebUI TownView 同源):主绿/数据青/深底。
// 零依赖 ANSI 包装(pi-tui 已带 marked,这里不需要 chalk)。
// ============================================================

const RESET = '\x1b[0m'
const rgb = (r, g, b) => s => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`
const dim = s => `\x1b[2m${s}${RESET}`
const bold = s => `\x1b[1m${s}${RESET}`

export const theme = {
  /** 主绿(Agent/成功/强调) */
  accent: rgb(53, 224, 160),
  /** 数据青(用户章/链接色) */
  info: rgb(65, 200, 244),
  /** 警示琥珀(HITL 待办) */
  warn: rgb(228, 168, 64),
  /** 错误红 */
  error: rgb(235, 96, 96),
  /** 弱化文本(时间戳/分隔线) */
  faint: dim,
  bold,
  /** 编辑器边框(pi-tui EditorTheme) */
  editor: {
    borderColor: rgb(53, 224, 160),
    selectList: {
      selectedPrefix: s => `${rgb(53, 224, 160)('›')} ${s}`,
      selectedText: s => rgb(65, 200, 244)(s),
      description: dim,
      scrollInfo: dim,
      noMatch: s => s,
    },
  },
}

/** 剥离 ANSI(纯文本对比/断言用) */
// eslint-disable-next-line no-control-regex
export const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
