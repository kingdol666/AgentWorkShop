/**
 * 宿主初始化(加载配置、种子服务、装载全部插件)
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { HookBus, createRouteTable } from '@/sdk/index.mjs'
import { ensureStateWatcher } from './toggle.mjs'
import { existsSync } from 'node:fs'
import { g, log, modePaths, pathToUrl } from './config.mjs'
import { join } from 'node:path'
import { loadAllPlugins, relayConfigEvents } from './load.mjs'
import { syncPluginSettings } from './rollback.mjs'

export async function initPluginHost({ cwd = process.cwd(), packageRoot } = {}) {
  if (g.__awPluginHost) return g.__awPluginHost
  const logger = log()
  const homeDir = modePaths(cwd).homeDir
  const host = {
    bus: new HookBus({
      name: 'aw-plugins',
      onError: (err, meta) => logger.warn(`钩子错误(${meta?.type}):`, err?.message ?? err),
    }),
    routes: createRouteTable(),
    plugins: new Map(),
    disposables: new Map(), // name → fn[](ctx.onDispose 登记)
    hookOffs: new Map(), // name → off[](ctx.hooks.on 登记;热重载时解绑)
    failures: [],
    initedAt: null,
    cwd,
    packageRoot,
    logger,
    configRelayOff: null,
  }
  g.__awPluginHost = host

  // 有效配置(只读面;引擎/模式解析从运行根动态加载)
  let config = null
  let settingsPath = null
  let paths = { home: homeDir, configRoot: join(cwd, '.AgentWorkShop'), dataDir: join(cwd, '.AgentWorkShop', 'data') }
  try {
    const homeMod = await import(pathToUrl(join(cwd, 'shared', 'config', 'home.mjs')))
    const rm = homeMod.resolveRunMode({ cwd, packageRoot, env: process.env })
    const engineRoot = rm.mode === 'repo' ? rm.root : (packageRoot ?? rm.root)
    if (engineRoot && existsSync(join(engineRoot, 'shared', 'config', 'engine.mjs'))) {
      const engine = await import(pathToUrl(join(engineRoot, 'shared', 'config', 'engine.mjs')))
      config = engine.loadEffective({ configPath: rm.configPath, settingsPath: rm.settingsPath, env: process.env })
      settingsPath = rm.settingsPath
    }
    paths = { home: rm.home, configRoot: rm.configRoot, dataDir: rm.dataDir }
    host.logger.info(`配置根: ${rm.configRoot} (${rm.mode} 模式)`)
  }
  catch (err) {
    host.logger.warn('配置引擎加载降级(插件 ctx.config 将为空):', err?.message)
  }
  // 配置热更新:system-config 变化(设置页 PATCH / runtime-settings 文件监听)即刷新
  // effective —— 插件 ctx.config.get 每次调用实时读到新值(插件 API 地址等改配置即生效,无需重启)
  try {
    const { getSystemConfigService } = await import('@/server/services/system-config')
    getSystemConfigService().subscribe((tail) => {
      try {
        if (config?.effective && tail?.effective) Object.assign(config.effective, tail.effective)
      }
      catch { /* 刷新失败保留旧值 */ }
    })
  }
  catch (err) {
    host.logger.warn('配置热更新订阅失败(插件 ctx.config 为装载时快照):', err?.message)
  }
  host.config = config

  // 自环 origin:PORT env(prod:start.mjs 注入 / dev:dev-guard 注入 CLI 显式值)权威;
  // nitro listen 钩子兜底回填
  const argPort = (() => {
    const argv = process.argv
    const i = argv.indexOf('--port')
    if (i >= 0 && argv[i + 1]) return argv[i + 1]
    const eq = argv.find(a => a.startsWith('--port='))
    return eq ? eq.slice(7) : null
  })()
  let selfOrigin = `http://127.0.0.1:${process.env.PORT ?? process.env.NITRO_PORT ?? argPort ?? config?.effective?.['server.dev.port'] ?? 3000}`
  host.setSelfOrigin = (port) => {
    selfOrigin = `http://127.0.0.1:${port}`
    host.logger.info(`自环 origin 就绪: ${selfOrigin}`)
  }
  host.selfOrigin = () => selfOrigin
  host.logger.info(`自环 origin: ${selfOrigin}`)

  await loadAllPlugins(host, { config, settingsPath, paths })
  await syncPluginSettings()
  relayConfigEvents(host)
  ensureStateWatcher(host)
  return host
}

/**
 * 平台设置变更 → 转发到插件总线。
 *
 * SDK 的 `ctx.config.onChange(fn)` 订阅的是 `config:changed`,而该事件此前只广播给
 * SystemConfigService 自己的 listeners —— 插件永远收不到,「配置变更即时生效」对插件
 * 是空承诺(实测:改 base_url 后插件的出站守卫仍沿用装载期判定)。这里做一次桥接。
 * 只在宿主初始化时挂一次(热重载不会重复订阅)。
 */
