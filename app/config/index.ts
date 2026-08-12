import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'
import { appConfigSchema, type AppConfig } from './schema'

// config.yml 固定位于项目根目录；按文件位置解析，不依赖 process.cwd()
const configPath = fileURLToPath(new URL('../../config.yml', import.meta.url))

let cached: AppConfig | null = null

/**
 * 读取并校验 config.yml。结果缓存，整个构建期只解析一次。
 * 仅在构建期（nuxt.config）调用；应用运行时请使用 useRuntimeConfig().
 */
export function loadConfig(): AppConfig {
  if (cached) return cached
  const raw = YAML.load(readFileSync(configPath, 'utf8'))
  cached = appConfigSchema.parse(raw)
  return cached
}

export { appConfigSchema } from './schema'
export type { AppConfig } from './schema'
