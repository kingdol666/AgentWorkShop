/**
 * Nuxt `#imports` 测试桩 —— 纯 node / tsx 环境下加载 server 侧源码时使用
 * (无 Nuxt 运行时,`#imports` 这个虚拟模块在 Node ESM 里不可解析)。
 *
 * 只实现 server 侧真正用到的 `useRuntimeConfig()`:取值来自**共享配置引擎**
 * (shared/config/engine.mjs,config.yml 的单一事实来源),映射口径与
 * nuxt.config.ts 的 `runtimeConfig` 逐键一致 —— 回归脚本看到的配置与真实
 * Nitro 运行期同源,不引入第二套默认值。
 *
 * 仅用于脚本/回归;真实运行始终走 Nuxt → Nitro。挂在 scripts/_audit/ts-resolve-hook.mjs 上。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUp, loadEffective, settingsPathFor } from '../../../shared/config/engine.mjs'

const REPO = pathResolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 定位配置根(含 config.yml 的目录;优先 cwd 向上,再回落仓库根) */
function configRoot() {
  try {
    const hit = findUp(process.cwd(), 'config.yml')
    if (hit) return dirname(hit)
  }
  catch { /* 继续 */ }
  return existsSync(join(REPO, 'config.yml')) ? REPO : process.cwd()
}

/** 等价于 Nuxt 的 useRuntimeConfig()(public + 服务端专用键) */
export function useRuntimeConfig() {
  const root = configRoot()
  const settings = settingsPathFor(root)
  const { effective } = loadEffective({
    configPath: join(root, 'config.yml'),
    settingsPath: existsSync(settings) ? settings : undefined,
  })
  const get = (key, fallback) => (effective[key] !== undefined ? effective[key] : fallback)

  return {
    apiPageSize: get('api.pageSize', 20),
    apiMaxPageSize: get('api.maxPageSize', 100),
    session: { password: get('security.sessionPassword', '') },
    approvalGate: get('security.approvalGate', false),
    daq: {
      startInfrastructure: get('daq.startInfrastructure', 'auto'),
      mqtt: { host: get('daq.mqtt.host', '127.0.0.1'), port: get('daq.mqtt.port', 1883) },
      timescale: { host: get('daq.timescale.host', '127.0.0.1'), port: get('daq.timescale.port', 5432) },
    },
    public: {
      appName: get('app.name', 'AgentWorkShop'),
      appTitle: get('app.title', 'AgentWorkShop'),
      version: get('app.version', '0.0.0'),
      description: get('app.description', ''),
      mode: get('mode', 'dev'),
      apiBase: get('api.baseURL', '/api'),
      apiTimeout: get('api.timeout', 15_000),
      primaryColor: get('theme.primaryColor', '#35e0a0'),
      themeMode: get('theme.mode', 'light'),
      serverHost: get('server.host', '0.0.0.0'),
      devPort: get('server.dev.port', 3000),
      prodPort: get('server.prod.port', 3001),
      defaultLocale: get('i18n.defaultLocale', 'zh-CN'),
    },
  }
}

export default { useRuntimeConfig }
