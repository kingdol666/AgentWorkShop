// ============================================================
// AgentWorkShop CLI — 极简 argv 解析器
// 支持：
//   --flag            → 布尔 true
//   --flag=value      → 值
//   --flag value      → 值（下一 token 非选项时）
//   -x value / -x     → 短选项（映射到长名）
//   --                 → 之后全部为位置参数
// ============================================================

/**
 * 全局选项规格 —— **取值边界的事实源**。
 *
 * 为什么需要这张表:`--root <dir>` 后面跟着的 `<dir>` 是取值,不是位置参数。
 * 不知道该信息的两处逻辑都会出错:
 *   - 指令名提取(extractCommandName):`aw --root /x version` 会把 `/x` 当成指令名
 *     → "未知指令: /x"(用户只能被迫写 `--root=/x` 等号形式);
 *   - 全局项剥离(stripGlobals):布尔项 `--json` 后面若跟位置参数,会被误当成它的取值吞掉
 *     → `aw --json build` 里 `build` 消失。
 * 因此两处统一读这张表,而不是各自猜。
 */
export const GLOBAL_OPTS = [
  { name: '--json', value: false },
  { name: '--debug', value: false },
  { name: '--help', value: false, short: '-h' },
  { name: '--version', value: false, short: '-v' },
  { name: '--root', value: true },
]

/** 带取值的全局选项名(如 ['--root']) */
export function globalValueNames() {
  return GLOBAL_OPTS.filter(o => o.value).map(o => o.name)
}

/** 全部全局选项名(布尔 + 带值) */
export function globalNames() {
  return GLOBAL_OPTS.map(o => o.name)
}

/**
 * 提取指令名:首个**位置 token**(自动跳过全局选项及其取值)。
 *
 * `aw --root /x version`  → 'version'(旧实现返回 '/x',指令派发直接失败)
 * `aw --json build`       → 'build'
 * `aw -- build`           → 'build'(`--` 之后一律位置参数)
 * `aw -`                  → '-'(单个连字符按 stdin 约定视为位置参数)
 *
 * @param {string[]} argv
 * @param {{ valueNames?: string[] }} [opts] 带取值的选项名(缺省用全局表)
 */
export function extractCommandName(argv, opts = {}) {
  const valueNames = new Set(opts.valueNames ?? globalValueNames())
  let afterDash = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (afterDash) return tok
    if (tok === '--') {
      afterDash = true
      continue
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=')
      // 等号形式自带取值;分离形式才需要连带跳过下一个 token
      if (eq < 0 && valueNames.has(tok)) i++
      continue
    }
    // 短选项:-h/-v 这类布尔项只占一位;'-' 单独出现是位置参数
    if (tok.length > 1 && tok.startsWith('-')) continue
    return tok
  }
  return null
}

/**
 * 解析 argv（不含 node/script 前两项）。返回 { flags, positionals, unknown }
 *
 * @param {string[]} argv
 * @param {{
 *   shortMap?: Record<string, string>,
 *   skip?: (consumed: string[], next: string | undefined) => number,
 * }} [options]
 *   skip: 在某个 flag 被完整消费后调用,返回「额外跳过」的 token 数。
 *         用于按位置剥离全局选项（不能按字面量过滤——见 stripGlobals）。
 */
export function parseArgs(argv, { shortMap = {}, skip } = {}) {
  const flags = {}
  const positionals = []
  const unknown = []

  /** flag 被完整消费（含可能的取值 token）后,按 skip 决定额外跳过的 token 数 */
  const extraSkip = (consumed, next) => {
    if (typeof skip !== 'function') return 0
    const n = skip(consumed, next)
    return Number.isInteger(n) && n > 0 ? n : 0
  }

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
      // 注意:bare flag（value===true）的 next 是「未被本 flag 消费」的 token,
      // 有意不传给 skip —— 全局选项只在带值时其取值 token 才可能同名。
      i += 1 + extraSkip([tok], value === true ? undefined : argv[i + 1])
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
        i += 1 + extraSkip([tok], next)
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

/**
 * 按位置剥离全局选项（供 cli/aw.mjs 计算指令局部 argv）。
 *
 * 为什么不能按字面量过滤:同名 token 可能是某个 flag 的「值」而非选项本身,
 *   ['--name', '--json']    --json 是 --name 的值 → 过滤会把它删掉,值丢失
 *   ['--name=--json']       同理（等号形式的值）
 *   ['--json', 'x']         位置 0 的 --json 才是真正的全局选项
 * 这里复用 parseArgs 的消费逻辑,只在 token 处于「选项位」时剔除,
 * 值位上的同名 token 原样保留。
 *
 * **取值边界必须显式声明**:布尔项(`--json`/`--debug`)只占一个 token,
 * 绝不吞掉紧随其后的位置参数 —— 旧实现对所有被剔除项一律套用"下一 token 非选项
 * 就当取值吃掉",于是 `aw build --json x` 里的 `x` 会静默消失。
 * 带值项(`--root`)经 opts.valueNames 声明后,才连同取值 token 一起移除。
 *
 * @param {string[]} argv
 * @param {string[]} names 需剔除的长选项名（含 -- 前缀）,如 ['--json','--debug']
 * @param {{ valueNames?: string[] }} [opts]
 *   valueNames: names 中**带取值**的子集(缺省 [] = 全部按布尔处理)
 * @returns {string[]} 剔除全局选项后的 argv（保序;其余 token 原样保留）
 */
export function stripGlobals(argv, names, opts = {}) {
  const drop = new Set(names)
  const takesValue = new Set(opts.valueNames ?? [])
  const kept = []
  let i = 0
  let afterDoubleDash = false
  while (i < argv.length) {
    const tok = argv[i]
    // '--' 之后全是位置参数,不再剥离
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true
      kept.push(tok)
      i++
      continue
    }
    if (afterDoubleDash) {
      kept.push(tok)
      i++
      continue
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2)
      const eq = body.indexOf('=')
      const name = '--' + (eq >= 0 ? body.slice(0, eq) : body)
      const hasInlineValue = eq >= 0
      // 下一步会吃掉的取值 token（可能是「作为值出现的同名 token」,不得误删）
      const next = argv[i + 1]
      const willConsumeNext = !hasInlineValue
        && next !== undefined && !next.startsWith('-') && next !== ''
      if (drop.has(name)) {
        // 仅**声明了带值**的全局项才连取值一起移除;布尔项只移除自身
        const eats = willConsumeNext && takesValue.has(name)
        i += 1 + (eats ? 1 : 0)
        continue
      }
      kept.push(tok)
      if (willConsumeNext) {
        kept.push(next)
        i += 2
        continue
      }
      i++
      continue
    }
    kept.push(tok)
    i++
  }
  return kept
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
