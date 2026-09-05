// ============================================================
// AgentWorkShop 插件宿主 —— 发现 / 装载 / 启停状态 / 热重载 / 路由表
// ------------------------------------------------------------
// 目录(与 aw commands 同哲学):
//   project: <repo>/.AgentWorkShop/plugins/<name>/index.mjs
//   user:    ~/.AgentWorkShop/plugins/<name>/index.mjs(同名 project 优先)
// 契约:入口导出普通对象 { name, version?, description?, setup(ctx)?,
//   client?: './client.mjs', routes?: [{method,path,handler}] }
// —— ctx 由宿主注入,插件运行时零导入依赖(sdk/ 供类型与显式糖)。
//
// 启停状态机:配置根 plugins-state.json { version, updatedAt, disabled: string[] }
//   · 装载时跳过 disabled 插件(manifest 仍可见,enabled:false)
//   · 状态文件变化(fs.watch)→ 热重载:全部 dispose/解绑 → 重新装载
//   · CLI(aw plugin enable/disable) 与 Web 设置页均只写状态文件,服务自感知
// 错误隔离:单插件装载/执行失败记入 failures,绝不拖垮主服务。
// ============================================================
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HookBus, createPluginContext, createRouteTable, validatePluginModule } from '@/sdk/index.mjs'

const g = globalThis

function log() {
  return {
    debug: (...a) => console.log('[aw-plugins][debug]', ...a),
    info: (...a) => console.log('[aw-plugins]', ...a),
    warn: (...a) => console.warn('[aw-plugins]', ...a),
    error: (...a) => console.error('[aw-plugins]', ...a),
  }
}

function defaultHome() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return join(home, '.AgentWorkShop')
}

/** 运行模式路径(cwd 为检出根时启用 project 作用域) */
function modePaths(cwd) {
  const isRepo = existsSync(join(cwd, 'config.yml')) && existsSync(join(cwd, 'nuxt.config.ts'))
  return {
    projectDir: isRepo ? join(cwd, '.AgentWorkShop', 'plugins') : null,
    userDir: join(process.env.AW_HOME && String(process.env.AW_HOME).trim() ? String(process.env.AW_HOME).trim() : defaultHome(), 'plugins'),
    homeDir: process.env.AW_HOME && String(process.env.AW_HOME).trim() ? String(process.env.AW_HOME).trim() : defaultHome(),
  }
}

function pathToUrl(p) {
  return pathToFileURL(resolve(p)).href
}

// ---- 启停状态(单一事实源:<配置根>/plugins-state.json;CLI/Web/宿主三方读写) ----
export function statePathFor(homeDir) {
  return join(homeDir, 'plugins-state.json')
}

export function readDisabledSet(homeDir) {
  try {
    const j = JSON.parse(readFileSync(statePathFor(homeDir), 'utf8'))
    return new Set(Array.isArray(j.disabled) ? j.disabled : [])
  }
  catch {
    return new Set()
  }
}

export function writeDisabledSet(homeDir, disabled) {
  const p = statePathFor(homeDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), disabled: [...disabled] }, null, 2)}\n`, 'utf8')
  renameSync(tmp, p)
}

/** 发现两个作用域下的插件入口(project 同名覆盖 user) */
export function discoverPluginDirs(cwd = process.cwd()) {
  const { projectDir, userDir } = modePaths(cwd)
  const out = []
  const seen = new Set()
  for (const [dir, scope] of [[projectDir, 'project'], [userDir, 'user']]) {
    if (!dir || !existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const sub = join(dir, name)
      if (!existsSync(join(sub, 'index.mjs'))) continue
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ dir: sub, scope })
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * 装载插件宿主(idempotent;nitro 启动期调用一次)。
 */
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
  ensureStateWatcher(host)
  return host
}

/** 装载/重载全部插件(跳过 disabled;manifest 仍可见) */
async function loadAllPlugins(host, { config, paths }) {
  const homeDir = modePaths(host.cwd).homeDir
  const disabled = readDisabledSet(homeDir)
  host.disabledSet = disabled

  const entries = discoverPluginDirs(host.cwd)
  if (entries.length) host.logger.info(`发现 ${entries.length} 个插件(停用 ${disabled.size}),开始装载 ...`)

  for (const { dir, scope } of entries) {
    const entry = join(dir, 'index.mjs')
    try {
      // cache-busting:热重载时 ESM 按 URL 缓存,不带 query 永远拿到旧模块(插件改代码不生效)
      const mod = await import(`${pathToUrl(entry)}?t=${Date.now()}`)
      const check = validatePluginModule(mod, entry)
      if (!check.ok) throw new Error(check.error)
      const def = check.def

      if (host.plugins.has(def.name)) throw new Error(`插件重名(后装载者跳过): ${def.name}`)
      if (disabled.has(def.name)) {
        host.plugins.set(def.name, {
          name: def.name,
          version: String(def.version ?? '0.0.0'),
          description: String(def.description ?? ''),
          scope,
          dir,
          entry,
          clientPath: def.client ? resolve(dir, def.client) : null,
          routes: [],
          enabled: false,
          error: null,
        })
        host.logger.info(`⊘ 跳过(已停用) [${scope}] ${def.name}`)
        continue
      }

      const rec = {
        name: def.name,
        version: String(def.version ?? '0.0.0'),
        description: String(def.description ?? ''),
        scope,
        dir,
        entry,
        clientPath: def.client ? resolve(dir, def.client) : null,
        routes: [],
        enabled: true,
        error: null,
      }

      const emitter = {
        registerRoute: (n, m, p, h) => {
          host.routes.register(n, m, p, h)
          rec.routes.push({ method: String(m).toUpperCase(), path: p })
        },
      }
      const perPluginDisposables = []
      const hookOffs = []
      host.disposables.set(def.name, perPluginDisposables)
      host.hookOffs.set(def.name, hookOffs)
      const scopedHooks = {
        on: (t, fn) => {
          const off = host.bus.on(t, fn)
          hookOffs.push(off)
          return off
        },
        once: (t, fn) => {
          const off = host.bus.once(t, fn)
          hookOffs.push(off)
          return off
        },
        off: (t, fn) => host.bus.off(t, fn),
        emit: (t, p) => host.bus.emit(t, p),
      }
      const ctx = createPluginContext({
        name: def.name,
        scope,
        dir,
        hooks: scopedHooks,
        logger: {
          debug: (...a) => host.logger.info(`[${def.name}][debug]`, ...a),
          info: (...a) => host.logger.info(`[${def.name}]`, ...a),
          warn: (...a) => host.logger.warn(`[${def.name}]`, ...a),
          error: (...a) => host.logger.error(`[${def.name}]`, ...a),
        },
        config,
        paths,
        emitter,
        onDispose: (fn) => {
          perPluginDisposables.push(fn)
          return fn
        },
        selfOrigin: () => selfOriginRef(host),
      })
      // DAQ 扩展面(v2 帧管线):插件注册自定义驱动与下沉处理器。
      // 桥经 globalThis 排队 —— daq 模块晚于插件宿主装载时,注册项先排队、
      // daq 侧 plugin-bridge 接管后回放;重复装载由同名覆盖语义兜底。
      const daqExt = (globalThis.__daqPluginExt ??= {
        pendingDrivers: [],
        pendingProcessors: [],
        pendingTemplates: [],
        registerDriver(d) {
          this.pendingDrivers.push(d)
          this._drain?.()
        },
        registerProcessor(kind, name, fn) {
          this.pendingProcessors.push({ kind, name, fn })
          this._drain?.()
        },
        registerTemplate(def) {
          this.pendingTemplates.push(def)
          this._drain?.()
        },
        drain(onDriver, onProcessor, onTemplate) {
          this._drain = () => {
            for (const d of this.pendingDrivers.splice(0)) onDriver(d)
            for (const p of this.pendingProcessors.splice(0)) onProcessor(p.kind, p.name, p.fn)
            for (const t of this.pendingTemplates.splice(0)) onTemplate(t)
          }
          this._drain()
        },
      })
      ctx.daq = {
        registerDriver: d => daqExt.registerDriver(d),
        registerProcessor: (kind, name, fn) => daqExt.registerProcessor(kind, name, fn),
        /** 注册数采节点模板(signalKind/sink.processors/metrics 全量可用;同名覆盖) */
        registerTemplate: def => daqExt.registerTemplate(def),
        /** 帧消费便捷别名(= hooks.on('daq:frame') / hooks.on('daq:sample')) */
        onFrame: fn => scopedHooks.on('daq:frame', fn),
        onSample: fn => scopedHooks.on('daq:sample', fn),
      }
      // OMP 工具扩展面:插件注册自定义 host 工具 → omp 会话运行时热注入
      const ompExt = (globalThis.__ompPluginToolsBridge ??= {
        pending: [],
        register(plugin, tool) {
          this.pending.push({ plugin, tool })
          this._drain?.()
        },
        drain(onTool) {
          this._drain = () => {
            for (const def of this.pending.splice(0)) onTool(def)
          }
          this._drain()
        },
      })
      ctx.omp = {
        registerTool: (tool) => {
          ompExt.register(def.name, tool)
          ctx.logger.info(`已注册 omp 工具:「${tool?.name}」`)
        },
      }

      for (const r of (Array.isArray(def.routes) ? def.routes : [])) {
        emitter.registerRoute(def.name, r.method ?? 'GET', r.path, r.handler)
      }
      await def.setup?.(ctx)

      host.plugins.set(def.name, rec)
      host.logger.info(`✔ 已装载 [${scope}] ${def.name}@${rec.version}${rec.clientPath ? ' (+client)' : ''}`)
    }
    catch (err) {
      host.failures.push({ source: entry, error: err?.message ?? String(err) })
      host.logger.error(`装载失败 ${entry}:`, err?.message ?? err)
    }
  }

  host.initedAt = new Date().toISOString()
  await host.bus.emit('plugin:host:init', { plugins: [...host.plugins.keys()], failures: host.failures.length })
  host.logger.info(`装载完成: ${host.plugins.size} 个(含停用)/ ${host.failures.length} 失败 / 活跃路由 ${host.routes.size} 条`)
}

function selfOriginRef(host) {
  return host.selfOrigin()
}

/** 热重载:全部 dispose/解绑 → 重新装载(跳过停用)→ 广播 plugins.reloaded(并发合并) */
export async function reloadPluginHost() {
  const host = getPluginHost()
  if (!host) return null
  if (host.reloadInFlight) return host.reloadInFlight
  host.reloadInFlight = doReload(host).finally(() => {
    host.reloadInFlight = null
  })
  return host.reloadInFlight
}

async function doReload(host) {
  host.logger.info('热重载插件宿主 ...')
  for (const [name, list] of host.disposables ?? []) {
    for (const fn of list.splice(0)) {
      try {
        await fn()
      }
      catch (err) {
        host.logger.warn(`[${name}] onDispose 失败:`, err?.message)
      }
    }
  }
  for (const offs of (host.hookOffs ?? new Map()).values()) {
    for (const off of offs.splice(0)) {
      try {
        off()
      }
      catch { /* 解绑失败忽略 */ }
    }
  }
  host.plugins.clear()
  host.routes = createRouteTable()
  host.failures = []
  await loadAllPlugins(host, { config: host.config, settingsPath: null, paths: { home: modePaths(host.cwd).homeDir, configRoot: join(host.cwd, '.AgentWorkShop'), dataDir: join(host.cwd, '.AgentWorkShop', 'data') } })
  await host.bus.emit('plugins:reloaded', { plugins: pluginManifest() })
  try {
    const m = await import('@/server/services/workshop/scene-events')
    m.broadcastSceneEvent('plugins.reloaded', { plugins: pluginManifest() })
  }
  catch { /* 广播失败不影响重载 */ }
  return host
}

/** 启停单插件(写状态文件;调用方随后 reloadPluginHost 或由 state watcher 触发) */
export function setPluginEnabled(name, enabled) {
  const host = getPluginHost()
  const homeDir = modePaths(host?.cwd ?? process.cwd()).homeDir
  const set = readDisabledSet(homeDir)
  if (enabled) set.delete(name)
  else set.add(name)
  writeDisabledSet(homeDir, set)
  return [...set]
}

/** 状态文件监视 → 热重载(CLI/Web 只写文件,服务自感知) */
function ensureStateWatcher(host) {
  const statePath = statePathFor(modePaths(host.cwd).homeDir)
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    if (!existsSync(statePath)) writeDisabledSet(modePaths(host.cwd).homeDir, new Set())
    let debounce = null
    watch(statePath, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        void reloadPluginHost()
      }, 400)
    })
  }
  catch (err) {
    host.logger.warn('状态文件监视不可用(启停需手动重启):', err?.message)
  }
}

/** 单例访问(未初始化返回 null —— 桥接点据此快速 no-op) */
export function getPluginHost() {
  return g.__awPluginHost ?? null
}

/** scene-events 桥:全部无频道实时事件 → 插件 event:<type> */
export function emitPluginEvent(type, payload) {
  void g.__awPluginHost?.bus.emit(`event:${type}`, payload)
}

/** DAQ 下发级采样钩子(与 WS daq.reading 同点、同节拍语义) */
export function emitDaqSample(payload) {
  void g.__awPluginHost?.bus.emit('daq:sample', payload)
}

/** 帧观察钩子(v2 多形态信号;载荷只含元数据/指标/预览,不含 blob) */
export function emitDaqFrame(payload) {
  void g.__awPluginHost?.bus.emit('daq:frame', payload)
}

/** 写控 ACK 后观察钩子 */
export function emitDcwWrite(payload) {
  void g.__awPluginHost?.bus.emit('dcw:write', payload)
}

/** 产线启停钩子 */
export function emitLineLifecycle(kind, payload) {
  void g.__awPluginHost?.bus.emit(kind, payload)
}

/** 客户端脚本读取(免鉴权只读端点用;越界路径拒绝) */
export function readClientScript(name) {
  const host = getPluginHost()
  const rec = host?.plugins.get(name)
  if (!host || !rec) return { status: 404 }
  if (!rec.clientPath || !existsSync(rec.clientPath)) return { status: 404 }
  if (!resolve(rec.clientPath).startsWith(resolve(rec.dir))) return { status: 400 }
  return { status: 200, code: readFileSync(rec.clientPath, 'utf8'), contentType: 'text/javascript; charset=utf-8' }
}

/** 清单(非敏感只读;含启停状态与路由) */
export function pluginManifest() {
  const host = getPluginHost()
  if (!host) return []
  return [...host.plugins.values()].map(r => ({
    name: r.name,
    version: r.version,
    description: r.description,
    scope: r.scope,
    enabled: r.enabled !== false,
    hasClient: Boolean(r.clientPath),
    routes: host.routes.byPlugin(r.name),
    error: r.error,
  }))
}

/** 关机钩子(nitro close 时调用):先逐插件回收订阅/定时器,再广播 server:close */
export async function shutdownPluginHost() {
  const host = getPluginHost()
  if (!host) return
  for (const [name, list] of host.disposables ?? []) {
    for (const fn of list.splice(0)) {
      try {
        await fn()
      }
      catch (err) {
        host.logger.warn(`[${name}] onDispose 失败:`, err?.message)
      }
    }
  }
  await host.bus.emit('server:close', { at: new Date().toISOString() })
  host.logger.info('插件清理完成,已发出 server:close')
}
