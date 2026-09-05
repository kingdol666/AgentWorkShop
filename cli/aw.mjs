// ============================================================
// AgentWorkShop CLI — 入口（bin/aw.mjs 直接导入本文件）
// ------------------------------------------------------------
// 启动流程：
//   1. 解析全局参数（--help/--version/--json/--root/--debug）
//   2. 探测项目根（--root 显式 > cwd 向上找 config.yml）
//   3. 建指令注册表：扫描 内建 → 用户级 → 项目级 三个目录（同名单后者覆盖，
//      即 项目级 > 用户级 > 内建,自定义指令可安全覆盖内建行为）
//   4. 组装运行上下文 ctx（含有效配置 API）并执行指令
//   5. 统一错误处理与退出码（0 成功 / 1 错误 / 2 用法错误）
// ============================================================
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CommandRegistry, commandDirs } from './core/registry.mjs'
import { createContext, EXIT } from './core/context.mjs'
import { parseArgs } from './core/args.mjs'
import { renderHelp, renderCommandHelp } from './core/help.mjs'
import { logger, color } from './core/logger.mjs'
import { CliError, isUsageError } from './core/errors.mjs'
import { installLocalIso } from '../shared/local-time.mjs'

// 全 CLI 时间输出统一本地时区(先于任何命令逻辑)
installLocalIso()

export { CliError }

/** 本包版本（cli/aw.mjs → ../package.json） */
export function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  }
  catch {
    return '0.0.0'
  }
}

/** 本包根目录（全局安装副本同样成立;必须走 fileURLToPath,Windows 下
 *  URL pathname 是 '/D:/...' 形态,直接 path.resolve 会得到 'D:\D:\...' 垃圾路径,
 *  导致内建指令目录扫描全部静默失败 —— 指令注册失效的根因） */
export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 向上查找文件（与 shared/config/engine.mjs 的 findUp 等价,避免顶层依赖引擎） */
function findUp(startDir, filename) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 从命令行提取指令名（首个非选项 token） */
function extractCommand(argv) {
  let afterDash = false
  for (const tok of argv) {
    if (afterDash) return tok
    if (tok === '--') {
      afterDash = true
      continue
    }
    if (tok.startsWith('-')) continue
    return tok
  }
  return null
}

function toBool(v, fallback = false) {
  if (v === undefined) return fallback
  if (typeof v === 'boolean') return v
  return !/^(false|0|no|off)$/i.test(String(v))
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const globals = parseArgs(argv, { shortMap: { h: 'help', v: 'version' } })
  const json = toBool(globals.flags.json)
  const debug = toBool(globals.flags.debug)
  const explicitRoot = globals.flags.root ? String(globals.flags.root) : undefined
  const commandName = extractCommand(argv)

  // --version
  if (globals.flags.version) {
    logger.info(`${color.bold('agentworkshop')} ${packageVersion()}`)
    return EXIT.OK
  }

  // 项目根探测
  const root = explicitRoot
    ? (existsSync(join(resolve(cwd, explicitRoot), 'config.yml')) ? resolve(cwd, explicitRoot) : null)
    : (() => {
        const p = findUp(cwd, 'config.yml')
        return p ? dirname(p) : null
      })()

  const homeDir = homedir()
  const pkgRoot = packageRoot()

  // 指令注册：内建(本包 cli/commands) → 用户级 → 项目级(同名单后者覆盖)
  const registry = new CommandRegistry()
  await registry.scanDirs(commandDirs({ packageRoot: pkgRoot, projectRoot: root, homeDir }))

  // aw help / aw <cmd> --help（先于"无指令"分支,保证 --help 退出码为 0）
  if (globals.flags.help || commandName === 'help') {
    const sub = commandName === 'help'
      ? argv[argv.indexOf('help') + 1]
      : commandName
    const target = sub && registry.find(sub) ? sub : undefined
    if (sub && !target) {
      logger.warn(`未知指令: ${sub}`)
      if (json) logger.info(JSON.stringify({ ok: false, error: 'unknown-command', name: sub }))
      logger.info(renderHelp({ registry, root, version: packageVersion() }))
      return EXIT.USAGE
    }
    logger.info(target ? renderCommandHelp(registry, target) : renderHelp({ registry, root, version: packageVersion() }))
    return EXIT.OK
  }

  // explicitRoot 只接受用户显式 --root:把自动探测的 root 冒充 explicitRoot 会在
  // context 内强制 configRoot=<root>/.AgentWorkShop,旁路 resolveRunMode 的
  // "检出内无 .AgentWorkShop → 回退 ~/.AgentWorkShop"规则(aw stop 因此停不掉 home 实例)
  const ctx = await createContext({ cwd, explicitRoot, json, debug, registry })

  // 无指令 → 帮助（用法错误码）
  if (!commandName) {
    logger.info(renderHelp({ registry, root, version: packageVersion() }))
    if (json) logger.info(JSON.stringify({ ok: false, error: 'usage', hint: 'no command' }))
    return EXIT.USAGE
  }

  const cmd = registry.find(commandName)
  if (!cmd) {
    if (!json) {
      logger.error(`未知指令: ${color.bold(commandName)}（aw help 查看全部指令）`)
    }
    else {
      logger.info(JSON.stringify({ ok: false, error: 'unknown-command', name: commandName }))
    }
    return EXIT.USAGE
  }

  // 项目上下文校验
  if (cmd.meta.needsProject && !root) {
    const msg = `指令 ${color.bold(commandName)} 需要项目上下文（未找到 config.yml）。请 cd 到项目目录，或 aw init 新建项目。`
    if (!json) logger.error(msg)
    else logger.info(JSON.stringify({ ok: false, error: 'no-project' }))
    return EXIT.ERROR
  }

  // 指令参数（剥离指令名与全局项）
  const idx = argv.indexOf(commandName)
  const cmdArgv = argv.slice(idx >= 0 ? idx + 1 : 0).filter(a => a !== '--json' && a !== '--debug')
  const local = parseArgs(cmdArgv, { shortMap: { h: 'help', ...(cmd.meta.short ?? {}) } })

  if (local.flags.help) {
    logger.info(renderCommandHelp(registry, commandName))
    return EXIT.OK
  }

  try {
    const code = await cmd.run(local, ctx)
    return code ?? EXIT.OK
  }
  catch (err) {
    if (err instanceof CliError) {
      if (!json) logger.error(err.message)
      else logger.info(JSON.stringify({ ok: false, error: err.code ?? 'cli-error', message: err.message }))
      return isUsageError(err) ? EXIT.USAGE : EXIT.ERROR
    }
    if (!json) {
      logger.error(`${color.bold(commandName)} 执行失败: ${err?.message ?? err}`)
      if (debug) console.error(err)
    }
    else {
      logger.info(JSON.stringify({ ok: false, error: 'internal', message: String(err?.message ?? err) }))
    }
    return EXIT.ERROR
  }
}

// 仅当直接以 cli/aw.mjs 作为入口时自动运行（bin/aw.mjs 会显式调用 main）
const thisEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (thisEntry) {
  process.exitCode = await main()
}

export default main
