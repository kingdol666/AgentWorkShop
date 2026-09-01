// ============================================================
// AgentWorkShop CLI — logger（轻量彩色日志；无第三方依赖）
// ============================================================
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY || process.env.TERM === 'dumb'

const c = n => s => (NO_COLOR ? s : `\u001b[${n}m${s}\u001b[0m`)
export const color = {
  bold: c(1),
  dim: c(2),
  red: c(31),
  green: c(32),
  yellow: c(33),
  blue: c(34),
  magenta: c(35),
  cyan: c(36),
  grey: c(90),
}

export const logger = {
  info(...args) { console.log(...args) },
  ok(...args) { console.log(`${color.green('✔')} ${args.join(' ')}`) },
  warn(...args) { console.log(`${color.yellow('⚠')} ${args.join(' ')}`) },
  error(...args) { console.error(`${color.red('✖')} ${args.join(' ')}`) },
  step(...args) { console.log(`${color.cyan('›')} ${args.join(' ')}`) },
  debug(...args) { if (process.env.AW_DEBUG) console.log(`${color.grey('[debug]')}`, ...args) },
  table(rows) {
    if (!rows.length) return
    const width = i => Math.max(...rows.map(r => String(r[i] ?? '').length))
    const pads = [0, 1, 2].map((i, idx) => idx === 0 ? width(0) : width(idx))
    for (const r of rows) {
      console.log(
        `  ${String(r[0] ?? '').padEnd(pads[0])}  `
        + `${color.grey(String(r[1] ?? '').padEnd(pads[1]))}  `
        + `${String(r[2] ?? '')}`,
      )
    }
  },
}

export default logger
