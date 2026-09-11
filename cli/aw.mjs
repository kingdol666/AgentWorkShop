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
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CommandRegistry, commandDirs } from './core/registry.mjs'
import { createContext, EXIT } from './core/context.mjs'
import { parseArgs, stripGlobals, extractCommandName, globalNames, globalValueNames } from './core/args.mjs'
import { renderHelp, renderCommandHelp } from './core/help.mjs'
import { logger, color } from './core/logger.mjs'
import { CliError, isUsageError } from './core/errors.mjs'
import { packageRoot, packageVersion } from './core/meta.mjs'
import { installLocalIso } from '../shared/local-time.mjs'

// 全 CLI 时间输出统一本地时区(先于任何命令逻辑)
installLocalIso()

export { CliError }

/** 本包版本/包根:实现下沉到叶子模块 cli/core/meta.mjs。
 *  命令模块要复用它们,若继续定义在本文件会让 cli/commands/* → ../aw.mjs 形成
 *  循环依赖,并在 **cli/aw.mjs 自任入口**时死锁(顶层 await main() 等 scanDirs,
 *  scanDirs 等命令模块,命令模块等 aw.mjs 求值完成)→ 退出码 13 且无输出。 */
export { packageRoot, packageVersion } from './core/meta.mjs'

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

/** 从命令行提取指令名（首个位置 token;跳过全局选项及其取值）
 *  实现在 args.mjs —— 与 stripGlobals 共用同一张取值边界表,避免两处各自猜。 */
function extractCommand(argv) {
  return extractCommandName(argv)
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
  // 必须按 token 逐个定位全局选项的取值边界;旧实现用
  //   .filter(a => a !== '--json' && a !== '--debug')
  // 按字面量剔除,会把出现在「值」位置的同名 token 一并删掉:
  //   aw foo --name --json      → --json 是 --name 的值,却被删 → --name 变布尔 true(值丢失)
  //   aw foo --title=b --json   → 同理
  // 取值边界由 GLOBAL_OPTS 声明(--root 带值,--json/--debug 为布尔):
  //   aw build --json x         → x 是位置参数,不得被 --json 吞掉
  //   aw --root /p build        → --root 连 /p 一起剥离
  const idx = argv.indexOf(commandName)
  const cmdArgv = stripGlobals(argv.slice(idx >= 0 ? idx + 1 : 0), globalNames(), { valueNames: globalValueNames() })
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
//
// 必须用 process.exit(code) 而非 process.exitCode = await main():
// 当 stdout/stderr 是管道(fd 为 socket,如重定向、CI、父进程 spawn 捕获)且仍有
// 未 flush 的挂起写入时,句柄会一直保活事件循环;Node 在 TLA 下因此以
// **退出码 13**(ERR_UNSETTLED_TOP_LEVEL_AWAIT)收场,把 aw --help / aw version 这类
// 纯诊断指令的成功退出写成 13。process.exit 会同步 flush 已排队的 stdio 写入
// (writev 直写 fd),因此既保住输出又保住退出码。
const thisEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (thisEntry) {
  process.exit(await main())
}

export default main
