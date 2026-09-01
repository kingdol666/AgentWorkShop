// shared/config/home.mjs 的类型声明（供 nuxt 构建期 TS / 服务端引用）

export declare const HOME_DIRNAME: string

/** 配置根：AW_HOME 环境变量 > ~/.AgentWorkShop */
export declare function awHome(env?: NodeJS.ProcessEnv): string

/** 是否为 AgentWorkShop 项目检出（config.yml + nuxt.config.ts 齐备） */
export declare function isRepoRoot(dir: string | null | undefined): boolean

/** 从指定目录向上找项目检出根；找不到返回 null */
export declare function findRepoRoot(startDir?: string): string | null

export interface RunModeInfo {
  mode: 'repo' | 'home'
  root: string | null
  /** 用户级根 ~/.AgentWorkShop（AW_HOME 可重定向） */
  home: string
  /** 当前生效配置根（repo=<repo>/.AgentWorkShop; home=~/.AgentWorkShop） */
  configRoot: string
  configPath: string
  settingsPath: string
  dataDir: string
}

/** 解析当前运行模式与全部路径（配置/设置/数据的单一判定入口） */
export declare function resolveRunMode(opts?: {
  cwd?: string
  packageRoot?: string
  env?: NodeJS.ProcessEnv
}): RunModeInfo

/** 运行数据目录：AW_DATA_DIR > home 模式配置根/data > repo 模式 cwd/.AgentWorkShop/data > cwd/data */
export declare function dataDirFor(cwd?: string, env?: NodeJS.ProcessEnv): string

/** 确保数据目录存在 + 旧位置(cwd/data、cwd/server/data)运行时文件迁入配置根（幂等） */
export declare function ensureDataDir(cwd?: string, env?: NodeJS.ProcessEnv): string

declare const _default: {
  HOME_DIRNAME: string
  awHome: typeof awHome
  isRepoRoot: typeof isRepoRoot
  findRepoRoot: typeof findRepoRoot
  resolveRunMode: typeof resolveRunMode
  dataDirFor: typeof dataDirFor
  ensureDataDir: typeof ensureDataDir
}
export default _default
