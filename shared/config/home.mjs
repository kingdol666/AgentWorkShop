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

/** 从 cwd 向上找项目级配置根(<dir>/.AgentWorkShop 目录真实存在);找不到返回 null。
 *  向上不超过用户主目录——~/.AgentWorkShop 是回退根,不能被误判为某项目的运行时根 */
export function findLocalConfigRoot(startDir = process.cwd()) {
  const home = homedir()
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, HOME_DIRNAME)
    if (dir !== home && existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    const parent = dirname(dir)
    if (parent === dir || dir === home) return null
    dir = parent
  }
}

/**
 * 解析当前运行模式与全部路径。
 * 配置根优先级（用户规约：项目 ./.AgentWorkShop > ~/.AgentWorkShop）：
 *   ① env.AW_MODE === 'home' 显式强制 home 模式（启动器对全局安装的应用载荷注入;
 *      否则包目录自身含 config.yml+nuxt.config.ts 会被误判为检出）
 *   ② cwd 向上找到真实存在的 ./.AgentWorkShop 目录 → 项目运行时根(检出或纯工作区皆可)
 *   ③ cwd 向上找到项目检出(config.yml+nuxt.config.ts)但无 ./.AgentWorkShop
 *      → 按规约回退 ~/.AgentWorkShop 作为运行时根(工厂默认 config.yml 仍取检出根)
 *   ④ 其余任意目录 → home 模式(~/.AgentWorkShop,AW_HOME 可重定向)
 * @returns {{
 *   mode: 'repo'|'home',
 *   root: string,            // repo=检出根; home=应用载荷根(本包)
 *   home: string,            // 用户级根 ~/.AgentWorkShop(AW_HOME 可重定向;用户级指令/全局配置)
 *   configRoot: string,      // 当前生效配置根(项目运行时=<项目>/.AgentWorkShop; 否则 ~/.AgentWorkShop)
 *   configPath: string,      // 生效的 config.yml(工厂默认;repo 在检出根,home 在配置根)
 *   settingsPath: string,    // 生效的 runtime-settings.json(两种模式都在配置根)
 *   dataDir: string,         // 运行数据目录(两种模式都在配置根)
 * }}
 */
export function resolveRunMode({ cwd, packageRoot, env = process.env } = {}) {
  const home = awHome(env)
  const startDir = cwd ?? process.cwd()
  const forceHome = env.AW_MODE === 'home'

  // ② 项目级 ./.AgentWorkShop 显式存在 → 它就是运行时根(最高优先)
  if (!forceHome) {
    const localConfigRoot = findLocalConfigRoot(startDir)
    if (localConfigRoot) {
      const projectRoot = dirname(localConfigRoot)
      const repoRoot = isRepoRoot(projectRoot) ? projectRoot : null
      return {
        mode: 'repo',
        root: repoRoot ?? projectRoot,
        home,
        configRoot: localConfigRoot,
        configPath: repoRoot
          ? join(repoRoot, 'config.yml')
          : (existsSync(join(localConfigRoot, 'config.yml')) ? join(localConfigRoot, 'config.yml') : join(packageRoot ?? '', 'config.yml')),
        settingsPath: join(localConfigRoot, 'runtime-settings.json'),
        dataDir: join(localConfigRoot, 'data'),
      }
    }
  }

  // ③ 检出内运行但无 ./.AgentWorkShop → 回退 ~/.AgentWorkShop(工厂默认配置仍在检出根)
  const repoRoot = forceHome ? null : findRepoRoot(startDir)
  if (repoRoot) {
    return {
      mode: 'repo',
      root: repoRoot,
      home,
      configRoot: home,
      configPath: join(repoRoot, 'config.yml'),
      settingsPath: join(home, 'runtime-settings.json'),
      dataDir: join(home, 'data'),
    }
  }

  // ④ home 模式
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
 *   AW_DATA_DIR 环境变量 > resolveRunMode 的配置根/data
 *   (项目 ./.AgentWorkShop 显式存在 > 检出内无 .AgentWorkShop 回退 ~/.AgentWorkShop
 *   > home 模式 ~/.AgentWorkShop/data > cwd/data 兜底)。
 * 启动器(scripts/start.mjs / dev-guard.mjs)会经 resolveRunMode 注入 AW_DATA_DIR;
 * 本函数为其兜底(直接 node .output/server/index.mjs 等无启动器场景)。
 */
export function dataDirFor(cwd = process.cwd(), env = process.env) {
  if (env.AW_DATA_DIR && String(env.AW_DATA_DIR).trim()) return resolve(String(env.AW_DATA_DIR).trim())
  const rm = resolveRunMode({ cwd, env })
  return rm.dataDir
}

/**
 * 确保数据目录存在，并把旧位置(cwd/data 与 cwd/server/data)的运行时文件
 * 迁入配置根（仅复制目标缺失的文件，不删除旧文件;幂等）。
 * 迁移覆盖 sqlite 主库/-wal/-shm 与 JSON 仓库文件;跳过 .tmp 临时产物。
 */
export function ensureDataDir(cwd = process.cwd(), env = process.env) {
  const dir = dataDirFor(cwd, env)
  mkdirSync(dir, { recursive: true })
  // 旧位置迁移仅当配置根就在 cwd 内(本地 ./.AgentWorkShop);回退 ~/.AgentWorkShop
  // 时不得把检出仓库的旧数据搬进用户全局根(跨项目污染)
  if (env.AW_MODE === 'home' || !resolve(dir).startsWith(resolve(cwd))) return dir
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
  findLocalConfigRoot,
  resolveRunMode,
  dataDirFor,
  ensureDataDir,
}
