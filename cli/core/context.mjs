// ============================================================
// AgentWorkShop CLI — 运行上下文（Context）
// ------------------------------------------------------------
// 职责：运行模式判定（repo 检出 / home 全局安装）、.env 预载、有效配置
// 加载与写入、nuxt 二进制解析、运行中服务器探测、子进程代理免疫环境。
// 所有指令共享同一份 ctx。
//
// 配置引擎采用"懒加载 + 项目根优先"：
//   全局安装的 aw 只是启动器，配置引擎从 <项目根 或 本包>/shared/config/engine.mjs
//   动态加载（js-yaml 由对应 node_modules 解析）→ 轻量 npm i -g --omit=dev
//   无需携带构建依赖；两种模式路径判定统一走 shared/config/home.mjs。
// ============================================================
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { awHome, ensureDataDir, findRepoRoot, resolveRunMode } from '../../shared/config/home.mjs'

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2 }

/** 预载 .env（不覆盖已存在的环境变量） */
export function preloadDotEnv(root) {
  const envPath = join(root, '.env')
  if (!existsSync(envPath)) return false
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    let val = m[2] ?? ''
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) val = val.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
  return true
}

/** 探测项目检出根：--root 显式 > cwd 向上找（config.yml + nuxt.config.ts） */
export function detectProjectRoot({ cwd, explicitRoot } = {}) {
  if (explicitRoot) {
    const abs = resolve(cwd, explicitRoot)
    return existsSync(join(abs, 'config.yml')) ? abs : null
  }
  return findRepoRoot(cwd)
}

/** 解析 nuxt CLI 入口（项目 node_modules 优先，退回本包） */
export function resolveNuxtBin(projectRoot, packageRoot) {
  const candidates = [projectRoot, packageRoot].filter(Boolean)
  for (const base of candidates) {
    try {
      const req = createRequire(join(base, 'package.json'))
      const pkg = req.resolve('nuxt/package.json')
      const bin = pkg.replace(/package\.json$/, 'bin/nuxt.mjs')
      if (existsSync(bin)) return bin
    }
    catch { /* 继续尝试 */ }
  }
  return null
}

/**
 * 加载共享配置引擎：运行根（repo 检出 / 本包）优先，回退本包副本。
 * 全部失败抛出带指引的错误。
 */
async function loadEngine(runRoot, packageRoot) {
  const candidates = [
    ...(runRoot ? [join(runRoot, 'shared', 'config', 'engine.mjs')] : []),
    join(packageRoot, 'shared', 'config', 'engine.mjs'),
  ]
  let lastErr
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      return await import(pathToFileURL(p).href)
    }
    catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `无法加载配置引擎(尝试过: ${candidates.join(' , ')})${lastErr ? `\n原因: ${lastErr.message}` : ''}`,
  )
}

/**
 * 项目经验：本机系统代理(如 7890)会拦截 localhost 回环请求。
 * aw 启动的所有子进程统一注入 NO_PROXY/no_proxy，免疫代理劫持。
 */
export function localBypassEnv(extra = {}) {
  const hosts = ['localhost', '127.0.0.1', '::1']
  const env = { ...process.env, ...extra }
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const parts = new Set(String(env[key] ?? '').split(',').map(s => s.trim()).filter(Boolean))
    for (const h of hosts) parts.add(h)
    env[key] = [...parts].join(',')
  }
  return env
}

/**
 * 创建指令运行上下文。
 * @returns {{
 *   cwd, root, mode: 'repo'|'home', home, packageRoot, homeDir, isProject, json, debug,
 *   config: { load(), save(), set(), unset(), reset(), validate() },   // 目标=repo 配置 ?? home 配置
 *   configRoot, configPath, settingsPath, dataDir,
 *   env: process.env, resolveNuxtBin(), registry, bypassEnv(extra), EXIT
 * }}
 */
export async function createContext({ cwd = process.cwd(), explicitRoot, json = false, debug = false, registry } = {}) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const homeDir = homedir()
  const root = detectProjectRoot({ cwd, explicitRoot })
  const mode = root ? 'repo' : 'home'
  const home = awHome(process.env)
  const isProject = Boolean(root)

  // 自定义命令目录：项目级(仅 repo 模式,与 prompts 外置约定同目录) + 用户级(=AW Home)
  const localCommands = root ? join(root, '.AgentWorkShop', 'commands') : null
  const globalCommands = join(home, 'commands')
  for (const dir of [localCommands, globalCommands].filter(Boolean)) {
    mkdirSync(dir, { recursive: true })
  }

  // 路径判定（单一入口）：repo 模式配置/数据在 <repo>/.AgentWorkShop;home 在 ~/.AgentWorkShop
  const paths = resolveRunMode({ cwd, packageRoot, env: process.env })
  // 显式 --root 时尊重显式值
  if (explicitRoot && root) {
    paths.configRoot = join(root, '.AgentWorkShop')
    paths.configPath = join(root, 'config.yml')
    paths.settingsPath = join(paths.configRoot, 'runtime-settings.json')
    paths.dataDir = join(paths.configRoot, 'data')
  }
  // repo 模式:确保配置根数据目录 + 旧位置(cwd/data 等)迁移(幂等,与服务端同规则)
  if (root) {
    ensureDataDir(root)
    paths.dataDir = join(paths.configRoot, 'data')
  }

  // 配置引擎（懒加载,运行根优先）+ 有效配置 API
  const engine = await loadEngine(root ?? packageRoot, packageRoot)
  const config = createConfigApi(paths, { engine, env: process.env })

  return {
    cwd,
    root,
    mode,
    home,
    packageRoot,
    homeDir,
    isProject,
    json,
    debug,
    env: process.env,
    commandsDir: { local: localCommands, global: globalCommands },
    configRoot: paths.configRoot,
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    dataDir: paths.dataDir,
    config,
    registry,
    resolveNuxtBin: () => resolveNuxtBin(root, packageRoot),
    bypassEnv: localBypassEnv,
    EXIT,
  }
}

/**
 * 配置操作 API（加载 / 保存 / 设置 / 移除 / 校验），基于共享引擎实例。
 * @param {{configPath, settingsPath, dataDir, mode}} paths resolveRunMode 的结果
 */
export function createConfigApi(paths, { engine, env = process.env } = {}) {
  const { configPath, settingsPath } = paths

  const load = () => engine.loadEffective({ configPath, settingsPath, env })

  const guard = () => {
    if (!configPath || !existsSync(configPath))
      throw new Error(`未找到配置 ${configPath} —— 请先运行 aw home 完成初始化，或 cd 到项目目录`)
  }

  return {
    root: paths.mode === 'repo' ? paths.root : null,
    mode: paths.mode,
    load,
    save(overrides) {
      guard()
      engine.saveSettings(overrides, settingsPath)
    },
    /** 设置单个键：校验 + 写入 overrides + 持久化。返回 { key, value, applies, ... } */
    set(key, rawValue) {
      guard()
      const { descriptors, overrides, effective, sources } = load()
      const map = Object.fromEntries(descriptors.map(d => [d.key, d]))
      const desc = map[key]
      if (!desc) throw new Error(`未知设置项 "${key}"（可用 aw config list 查看全部设置项）`)
      const coerced = engine.coerceValue(desc, rawValue)
      if (coerced === null) throw new Error(`无法把 "${rawValue}" 转为 ${desc.type} 类型`)
      const errs = engine.validateValue(desc, coerced)
      if (errs.length) throw new Error(`${desc.label} ${errs.join('，')}`)
      const next = { ...overrides, [key]: coerced }
      this.save(next)
      return { key, value: coerced, source: 'runtime', applies: desc.applies, previousSource: sources[key], effectiveBefore: effective[key] }
    },
    /** 移除某个覆盖（回落到 config.yml 默认） */
    unset(key) {
      guard()
      const { overrides } = load()
      if (!(key in overrides)) return { key, removed: false }
      const next = { ...overrides }
      delete next[key]
      this.save(next)
      return { key, removed: true }
    },
    /** 清空全部覆盖 */
    reset() {
      guard()
      this.save({})
    },
    validate() {
      guard()
      const { descriptors, overrides, defaults } = load()
      const result = { ok: true, keys: {}, overridesChecked: 0 }
      for (const desc of descriptors) {
        const val = engine.getPath(defaults, desc.key)
        if (val === undefined) continue
        const errs = engine.validateValue(desc, val)
        if (errs.length) {
          result.ok = false
          result.keys[desc.key] = [...(result.keys[desc.key] ?? []), ...errs.map(e => `config.yml: ${e}`)]
        }
      }
      const ov = engine.validateOverrides(overrides, descriptors)
      result.overridesChecked = Object.keys(overrides).length
      if (!ov.ok) {
        result.ok = false
        for (const [k, e] of Object.entries(ov.errors)) result.keys[k] = [...(result.keys[k] ?? []), ...e.map(x => `runtime: ${x}`)]
      }
      return result
    },
  }
}

/**
 * 探测正在运行的服务器（dev 优先，其次 prod），返回其 API 基址或 null。
 * 探活语义：拿到**任何** HTTP 响应（含 401 —— /api/system/config 需鉴权）
 * 即证明端口有服务在听；只有网络层失败才算离线。
 */
export async function findRunningServer(config, { timeoutMs = 400 } = {}) {
  if (!config?.load) return null
  const eff = config.load().effective
  const host = String(eff['server.host'] ?? '127.0.0.1').replace(/^0\.0\.0\.0$/, '127.0.0.1')
  const ports = [eff['server.dev.port'], eff['server.prod.port']].filter(p => p != null)
  for (const port of ports) {
    const url = `http://${host}:${port}/api/system/config`
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      await fetch(url, { method: 'GET', signal: ctl.signal })
      clearTimeout(timer)
      return { port, base: url.replace(/\/config$/, '') }
    }
    catch { /* 端口未起服务，继续 */ }
  }
  return null
}
