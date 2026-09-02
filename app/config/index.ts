import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import YAML from 'js-yaml'
import { appConfigSchema, type AppConfig } from './schema'
import {
  envOverridesFromEnv,
  loadDescriptors,
  readSettings,
  setPath,
  validateValue,
} from '../../shared/config/engine.mjs'
import { ensureDataDir, resolveRunMode } from '../../shared/config/home.mjs'

// 配置路径双模式判定（shared/config/home.mjs 单一入口）：
//   repo 模式（项目检出内构建/开发）→ config.yml 在检出根,运行时覆盖/数据在 <repo>/.AgentWorkShop
//   home 模式（全局安装载荷构建,AW_MODE=home）→ config.yml/runtime-settings 在 ~/.AgentWorkShop
// ensureDataDir 同时把旧 <repo>/data/runtime-settings.json 迁入配置根（幂等）
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const runMode = resolveRunMode({ cwd: process.cwd(), packageRoot, env: process.env })
const configPath = runMode.configPath
const settingsPath = process.env.AW_MODE === 'home'
  ? runMode.settingsPath
  : join(ensureDataDir(process.cwd(), process.env), '..', 'runtime-settings.json')

let cached: AppConfig | null = null

/**
 * 把运行时覆盖层合并进 config.yml 原始对象（就地修改）。
 * 优先级：config.yml < runtime-settings.json < 环境变量(AW_*)。
 * 每个键都过 schema.json 描述符校验，无效覆盖跳过并告警（不阻断启动）。
 * 这是 `aw config set` → Web 端真正生效的汇合点：CLI 写 runtime-settings，
 * 本函数在每次构建/启动时把它叠加到默认值上。
 */
function applyRuntimeOverrides(raw: Record<string, unknown>): void {
  const descriptors = loadDescriptors()
  const map = new Map(descriptors.map(d => [d.key, d]))
  const runtime = readSettings(settingsPath)
  const envOverrides = envOverridesFromEnv(process.env, descriptors)
  const merged = { ...runtime, ...envOverrides }
  for (const [key, value] of Object.entries(merged)) {
    const desc = map.get(key)
    if (!desc) continue
    const errs = validateValue(desc, value)
    if (errs.length) {
      console.warn(`[config] 忽略无效运行时覆盖 ${key}=${JSON.stringify(value)}: ${errs.join('; ')}`)
      continue
    }
    setPath(raw, key, value)
  }
}

/**
 * 读取并校验 config.yml（叠加运行时覆盖）。结果缓存，整个构建期只解析一次。
 * 仅在构建期（nuxt.config）调用；应用运行时请使用 useRuntimeConfig().
 */
export function loadConfig(): AppConfig {
  if (cached) return cached
  const raw = (YAML.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
  // 版本号唯一事实来源 = package.json;config.yml 的 app.version 仅作兜底,防止两处漂移
  if (raw.app == null || typeof raw.app !== 'object') raw.app = {}
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: string }
    if (pkg.version) (raw.app as Record<string, unknown>).version = pkg.version
  } catch { /* 载荷异常时保留 yml 兜底值 */ }
  applyRuntimeOverrides(raw)
  cached = appConfigSchema.parse(raw)
  return cached
}

export { appConfigSchema } from './schema'
export type { AppConfig } from './schema'
