// ============================================================
// AgentWorkShop CLI — 极简 argv 解析器
// 支持：
//   --flag            → 布尔 true
//   --flag=value      → 值
//   --flag value      → 值（下一 token 非选项时）
//   -x value / -x     → 短选项（映射到长名）
//   --                 → 之后全部为位置参数
// ============================================================

/** 解析 argv（不含 node/script 前两项）。返回 { flags, positionals } */
export function parseArgs(argv, { shortMap = {} } = {}) {
  const flags = {}
  const positionals = []
  const unknown = []

  let i = 0
  let afterDoubleDash = false
  while (i < argv.length) {
    const tok = argv[i]
    if (afterDoubleDash) {
      positionals.push(tok)
      i++
      continue
    }
    if (tok === '--') {
      afterDoubleDash = true
      i++
      continue
    }

    if (tok.startsWith('--')) {
      let name = tok.slice(2)
      let value = undefined
      const eq = name.indexOf('=')
      if (eq >= 0) {
        value = name.slice(eq + 1)
        name = name.slice(0, eq)
      }
      if (value === undefined) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--') && !next.startsWith('-') && next !== '') {
          value = next
          i++
        }
        else {
          value = true
        }
      }
      flags[name] = value
      i++
      continue
    }

    if (tok.startsWith('-') && tok.length > 1) {
      const short = tok.slice(1)
      if (shortMap[short]) {
        const name = shortMap[short]
        let value
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          value = next
          i++
        }
        else {
          value = true
        }
        flags[name] = value
        i++
        continue
      }
      unknown.push(tok)
      i++
      continue
    }

    positionals.push(tok)
    i++
  }

  return { flags, positionals, unknown }
}

/** 便捷：读取 flags 中的值或默认 */
export function flagValue(flags, name, fallback) {
  return flags[name] === undefined ? fallback : flags[name]
}

export function isTruthy(value) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null) return false
  return !/^(0|false|no|off|)$/i.test(String(value))
}

export default parseArgs
