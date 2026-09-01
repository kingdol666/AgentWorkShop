// ============================================================
// AgentWorkShop 配置根目录（.AgentWorkShop）解析 —— 零依赖，CLI / 启动脚本 /
// nuxt 构建期 / 服务端通用。类似 Claude Code 的 ~/.claude：全部配置、
// 数据、自定义指令都收敛在 .AgentWorkShop 文件夹，与当前工作目录和环境无关。
// ------------------------------------------------------------
// 两种运行模式（resolveRunMode 判定）：
//   repo  模式：cwd 向上能找到项目检出（config.yml + nuxt.config.ts）
//               → 配置根 = <repo>/.AgentWorkShop（运行时覆盖/数据/日志/指令），
//                 工厂默认 config.yml/.env 留在检出根（git 版本化）
//   home  模式：npm -g / npx 全局安装后任意目录 → 配置根 = ~/.AgentWorkShop
//               （AW_HOME 可重定向），应用载荷来自本包
// ============================================================
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const HOME_DIRNAME = '.AgentWorkShop'

/** 配置根：AW_HOME 环境变量 > ~/.AgentWorkShop */
export function awHome(env = process.env) {
  if (env.AW_HOME && String(env.AW_HOME).trim()) return String(env.AW_HOME).trim()
  return join(homedir(), HOME_DIRNAME)
}

/** 是否为 AgentWorkShop 项目检出（两个标记文件齐备） */
export function isRepoRoot(dir) {
  return Boolean(dir) && existsSync(join(dir, 'config.yml')) && existsSync(join(dir, 'nuxt.config.ts'))
}

/** 从 cwd 向上找项目检出根；找不到返回 null */
export function findRepoRoot(startDir = process.cwd()) {
  let dir = resolve(startDir)
  for (;;) {
    if (isRepoRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 解析当前运行模式与全部路径。
 * 优先级：env.AW_MODE === 'home' 显式强制 home 模式（启动器对全局安装的
 * 应用载荷注入;否则包目录自身含 config.yml+nuxt.config.ts 会被误判为检出）
 * > cwd 向上找检出 > home 模式。
 * @returns {{
 *   mode: 'repo'|'home',
 *   root: string,            // repo=检出根; home=应用载荷根(本包)
 *   home: string,            // 用户级根 ~/.AgentWorkShop(AW_HOME 可重定向;用户级指令/全局配置)
 *   configRoot: string,      // 当前生效配置根(repo=<repo>/.AgentWorkShop; home=~/.AgentWorkShop)
 *   configPath: string,      // 生效的 config.yml(工厂默认;repo 在检出根,home 在配置根)
 *   settingsPath: string,    // 生效的 runtime-settings.json(两种模式都在配置根)
 *   dataDir: string,         // 运行数据目录(两种模式都在配置根)
 * }}
 */
export function resolveRunMode({ cwd, packageRoot, env = process.env } = {}) {
  const home = awHome(env)
  const forceHome = env.AW_MODE === 'home'
  const repoRoot = forceHome ? null : findRepoRoot(cwd ?? process.cwd())
  if (repoRoot) {
    const configRoot = join(repoRoot, HOME_DIRNAME)
    return {
      mode: 'repo',
      root: repoRoot,
      home,
      configRoot,
      configPath: join(repoRoot, 'config.yml'),
      settingsPath: join(configRoot, 'runtime-settings.json'),
      dataDir: join(configRoot, 'data'),
    }
  }
  return {
    mode: 'home',
    root: packageRoot ?? repoRoot,
    home,
    configRoot: home,
    configPath: existsSync(join(home, 'config.yml')) ? join(home, 'config.yml') : join(packageRoot ?? '', 'config.yml'),
    settingsPath: join(home, 'runtime-settings.json'),
    dataDir: join(home, 'data'),
  }
}

/**
 * 运行数据目录（服务端/CLI 通用）：
 *   AW_DATA_DIR 环境变量 > home 模式(AW_MODE=home) 配置根/data
 *   > repo 模式(cwd 有 config.yml) cwd/.AgentWorkShop/data > cwd/data 兜底。
 * 启动器(scripts/start.mjs / dev-guard.mjs)会经 resolveRunMode 注入 AW_DATA_DIR;
 * 本函数为其兜底(直接 node .output/server/index.mjs 等无启动器场景)。
 */
export function dataDirFor(cwd = process.cwd(), env = process.env) {
  if (env.AW_DATA_DIR && String(env.AW_DATA_DIR).trim()) return resolve(String(env.AW_DATA_DIR).trim())
  if (env.AW_MODE === 'home') return join(awHome(env), 'data')
  if (existsSync(join(cwd, 'config.yml'))) return join(cwd, HOME_DIRNAME, 'data')
  return join(cwd, 'data')
}

/**
 * 确保数据目录存在，并把旧位置(cwd/data 与 cwd/server/data)的运行时文件
 * 迁入配置根（仅复制目标缺失的文件，不删除旧文件;幂等）。
 * 迁移覆盖 sqlite 主库/-wal/-shm 与 JSON 仓库文件;跳过 .tmp 临时产物。
 */
export function ensureDataDir(cwd = process.cwd(), env = process.env) {
  const dir = dataDirFor(cwd, env)
  mkdirSync(dir, { recursive: true })
  if (env.AW_MODE === 'home') return dir
  const legacyDirs = [join(cwd, 'data'), join(cwd, 'server', 'data')]
  for (const legacy of legacyDirs) {
    if (resolve(legacy) === resolve(dir) || !existsSync(legacy)) continue
    let entries
    try {
      entries = readdirSync(legacy)
    }
    catch {
      continue
    }
    for (const f of entries) {
      // 只搬运行时文件(sqlite 主库/-wal/-shm 与 JSON 仓库);.log/.mjs/.png 等杂物不入配置根
      if (!/\.(sqlite|sqlite-wal|sqlite-shm|json)$/.test(f)) continue
      const src = join(legacy, f)
      const dst = join(dir, f)
      try {
        if (!existsSync(dst) && statSync(src).isFile()) copyFileSync(src, dst)
      }
      catch { /* 单个文件迁移失败不阻断 */ }
    }
  }
  // 运行时覆盖迁入配置根(旧 <repo>/data/runtime-settings.json → <repo>/.AgentWorkShop/)
  const configRoot = resolve(dir, '..')
  const legacySettings = join(cwd, 'data', 'runtime-settings.json')
  const targetSettings = join(configRoot, 'runtime-settings.json')
  try {
    if (!existsSync(targetSettings) && existsSync(legacySettings)) copyFileSync(legacySettings, targetSettings)
  }
  catch { /* 迁移失败不阻断 */ }
  return dir
}

export default {
  HOME_DIRNAME,
  awHome,
  isRepoRoot,
  findRepoRoot,
  resolveRunMode,
  dataDirFor,
  ensureDataDir,
}
