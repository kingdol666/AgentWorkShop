// ============================================================
// AgentWorkShop CLI — 错误类型（独立模块,避免 commands → aw.mjs 循环依赖）
// ------------------------------------------------------------
// code: 'USAGE'(退出码 2,用法错误) | 其他(退出码 1,运行错误)
// ============================================================
export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

export function isUsageError(err) {
  return err instanceof CliError && err.code === 'USAGE'
}

export default CliError
