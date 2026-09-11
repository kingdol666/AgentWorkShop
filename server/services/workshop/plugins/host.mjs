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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HookBus, createPluginContext, createRouteTable, isPathInside, validatePluginModule, validatePluginGroups, validatePluginSettings } from '@/sdk/index.mjs'

// 延迟解析的产线权限服务(esbuild/别名下避免 nitro 打包循环导入;失败降级为拒绝一切)
let permissions = null
let userRepository = null
async function loadPermissions() {
  if (permissions) return
  try {
    permissions = await import('@/server/services/workshop/permissions')
    userRepository = await import('@/server/repositories/user.repository').then(m => m.userRepository)
  }
  catch (err) {
    hostLoggerFallback()?.warn('权限服务加载失败(插件 ctx.permissions 降级):', err?.message)
  }
}
function hostLoggerFallback() {
  return globalThis.__awPluginHost?.logger ?? console
}

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
  // packageRoot:宿主运行时取 initPluginHost 注入值;冒烟/单测(cwd 在包根)回退 cwd
  const packageRoot = g.__awPluginHost?.packageRoot ?? (isRepo ? cwd : null)
  const builtinDir = packageRoot ? join(packageRoot, 'server', 'plugins-builtin') : null
  return {
    builtinDir: builtinDir && existsSync(builtinDir) ? builtinDir : null,
    projectDir: isRepo ? join(cwd, '.AgentWorkShop', 'plugins') : null,
    userDir: join(process.env.AW_HOME && String(process.env.AW_HOME).trim() ? String(process.env.AW_HOME).trim() : defaultHome(), 'plugins'),
    homeDir: process.env.AW_HOME && String(process.env.AW_HOME).trim() ? String(process.env.AW_HOME).trim() : defaultHome(),
  }
}

function pathToUrl(p) {
  return pathToFileURL(resolve(p)).href
}

/** 插件根目录 i18n.json 路径(存在才返回;多语言消息包,按 plugin.<name> 命名空间注入前端) */
function pluginI18nPath(dir) {
  const p = join(dir, 'i18n.json')
  return existsSync(p) ? p : null
}

/** 读取并解析插件 i18n.json(形态 { "<locale>": { key: value } };坏文件返回 null 不阻断) */
export function readPluginI18n(rec) {
  if (!rec?.i18nPath || !existsSync(rec.i18nPath)) return null
  try {
    const obj = JSON.parse(readFileSync(rec.i18nPath, 'utf8'))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const out = {}
    for (const [locale, messages] of Object.entries(obj)) {
      if (messages && typeof messages === 'object' && !Array.isArray(messages)) out[locale] = messages
    }
    return Object.keys(out).length ? out : null
  }
  catch {
    return null
  }
}

/**
 * 全部插件的 i18n 消息包(免鉴权只读端点用;仅 UI 文案,插件作者不得放置敏感信息):
 * { "<plugin>": { "<locale>": { key: value } } }
 */
export function pluginI18nBundle() {
  const host = getPluginHost()
  if (!host) return {}
  const out = {}
  for (const rec of host.plugins.values()) {
    if (rec.enabled === false) continue
    const bundle = readPluginI18n(rec)
    if (bundle) out[rec.name] = bundle
  }
  return out
}

// ---- 后端运行时服务面(ctx.services;只读取数优先,跨插件服务带 <plugin>. 前缀) ----
const servicesExt = (g.__awPluginServices ??= {
  registry: new Map(),
  /** 核心服务注册(name → 惰性 getter);宿主启动期 seed */
  register(name, get) {
    this.registry.set(String(name), get)
  },
  /** 插件供服务(自动加 `<plugin>.` 前缀;同前缀同名覆盖) */
  provide(plugin, name, get) {
    this.registry.set(`${plugin}.${String(name)}`, get)
  },
  names() {
    return [...this.registry.keys()]
  },
  /** 取运行时服务对象(惰性求值并缓存;失败抛错由调用方兜底) */
  async get(name) {
    const get = this.registry.get(String(name))
    if (!get) throw new Error(`未知运行时服务: ${name}(可用: ${this.names().join(', ')})`)
    get._cache ??= get()
    return await get._cache
  },
})

/** 插件可获取的后端运行时对象(只读取数面;懒加载避免循环导入,失败即抛由插件兜底) */
async function seedRuntimeServices() {
  if (servicesExt.registry.has('daq')) return
  servicesExt.register('daq', async () => {
    const storage = await import('@/server/services/workshop/daq/storage/index')
    const nodes = await import('@/server/services/workshop/daq/daq-node.repo')
    return {
      query: q => storage.getTsdb().queryTagged(q),
      nodes: () => nodes.getDaqNodeRepo().snapshot(),
    }
  })
  servicesExt.register('lines', async () => {
    const m = await import('@/server/services/workshop/dcw/dcw-line.repo')
    const repo = m.getDcwLineRepo()
    return { list: () => repo.all(), byId: id => repo.byId(id) }
  })
  servicesExt.register('channels', async () => {
    const m = await import('@/server/plugins/workshop')
    const mgr = m.getWorkshopManager()
    return {
      list: () => mgr.deps.repos.channels.list(),
      agents: channelId => mgr.deps.repos.channelAgents.listByChannel(channelId),
    }
  })
  servicesExt.register('plugins', async () => pluginManifest())
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

/** 发现插件入口,三作用域(builtin 同名被 project 覆盖,project 同名被 user 覆盖) */
export function discoverPluginDirs(cwd = process.cwd()) {
  const { builtinDir, projectDir, userDir } = modePaths(cwd)
  const out = []
  const seen = new Set()
  for (const [dir, scope] of [[builtinDir, 'builtin'], [projectDir, 'project'], [userDir, 'user']]) {
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
function relayConfigEvents(host) {
  if (host.configRelayOff) return
  void import('@/server/services/system-config')
    .then(({ getSystemConfigService }) => {
      host.configRelayOff = getSystemConfigService().subscribe((payload) => {
        host.bus.emit('config:changed', {
          type: payload.type,
          changed: payload.changed ?? [],
          effective: payload.effective,
          sources: payload.sources,
        })
      })
    })
    .catch(err => host.logger.warn('设置变更转发到插件总线失败(插件收不到 config:changed):', err?.message ?? err))
}

/** 装载/重载全部插件(跳过 disabled;manifest 仍可见) */
async function loadAllPlugins(host, { config, paths }) {
  const homeDir = modePaths(host.cwd).homeDir
  const disabled = readDisabledSet(homeDir)
  host.disabledSet = disabled
  host.lastDisabledSnapshot = new Set(disabled) // 重装载竞态检测基线(见 reloadPluginHost)

  // 产线权限服务(ctx.permissions 注入用;失败降级)
  await loadPermissions()
  await seedRuntimeServices()

  const entries = discoverPluginDirs(host.cwd)
  if (entries.length) host.logger.info(`发现 ${entries.length} 个插件(停用 ${disabled.size}),开始装载 ...`)

  for (const { dir, scope } of entries) {
    const entry = join(dir, 'index.mjs')
    // 提到 try 外:catch 回滚需要知道插件名(def 在 try 内声明时 catch 不可见)
    let def = null
    try {
      // cache-busting:热重载时 ESM 按 URL 缓存,不带 query 永远拿到旧模块(插件改代码不生效)
      const mod = await import(`${pathToUrl(entry)}?t=${Date.now()}`)
      const check = validatePluginModule(mod, entry)
      if (!check.ok) throw new Error(check.error)
      def = check.def

      if (host.plugins.has(def.name)) throw new Error(`插件重名(后装载者跳过): ${def.name}`)
      if (disabled.has(def.name)) {
        host.plugins.set(def.name, {
          name: def.name,
          version: String(def.version ?? '0.0.0'),
          description: String(def.description ?? ''),
          auth: String(def.auth ?? 'none'),
          scope,
          dir,
          entry,
          clientPath: def.client ? resolve(dir, def.client) : null,
          i18nPath: pluginI18nPath(dir),
          settings: [],
          groups: [],
          routes: [],
          enabled: false,
          error: null,
        })
        host.logger.info(`⊘ 跳过(已停用) [${scope}] ${def.name}`)
        continue
      }

      // 插件设置声明 → 平台设置描述符(key 编址 plugins.<name>.<key>;校验失败仅告警跳过条目)
      const settingsCheck = validatePluginSettings(def.name, def.settings)
      for (const e of settingsCheck.errors) host.logger.warn(`[${def.name}] 设置声明已跳过: ${e}`)
      // 插件配置分组声明(manifest.configGroups;setup 里还可经 ctx.config.defineGroup 动态增加)
      const groupsCheck = validatePluginGroups(def.name, def.configGroups ?? [])

      const rec = {
        name: def.name,
        version: String(def.version ?? '0.0.0'),
        description: String(def.description ?? ''),
        auth: String(def.auth ?? 'none'),
        scope,
        dir,
        entry,
        clientPath: def.client ? resolve(dir, def.client) : null,
        i18nPath: pluginI18nPath(dir),
        settings: settingsCheck.descriptors,
        /** 本插件声明的配置分组(独占命名空间;卸载时随插件一起摘除) */
        groups: groupsCheck.groups,
        routes: [],
        enabled: true,
        error: null,
      }
      for (const e of groupsCheck.errors) host.logger.warn(`[${def.name}] 分组声明已跳过: ${e}`)

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
        // 插件配置分组/字段注册面(SDK ctx.config.defineGroup / defineField):
        // 插件可在 setup 里按条件增加自己的配置分区与字段,登记后立即回流设置页。
        registerGroup: (g) => {
          const chk = validatePluginGroups(def.name, [g])
          // validatePluginGroups 返回 { groups, errors }(无 ok 字段)——只认 groups 长度
          if (!chk.groups.length) {
            for (const e of chk.errors) host.logger.warn(`[${def.name}] ctx.config.defineGroup 失败: ${e}`)
            return null
          }
          const group = chk.groups[0]
          rec.groups = [...rec.groups.filter(x => x.id !== group.id), group]
          void syncPluginSettings()
          return group
        },
        registerField: (decl) => {
          const chk = validatePluginSettings(def.name, [decl])
          if (!chk.descriptors.length) {
            for (const e of chk.errors) host.logger.warn(`[${def.name}] ctx.config.defineField 失败: ${e}`)
            return null
          }
          const d = chk.descriptors[0]
          rec.settings = [...rec.settings.filter(x => x.key !== d.key), d]
          void syncPluginSettings()
          return d
        },
        removeGroup: (id) => {
          const before = rec.groups.length
          rec.groups = rec.groups.filter(x => x.id !== String(id))
          if (rec.groups.length !== before) void syncPluginSettings()
          return rec.groups.length !== before
        },
        removeField: (key) => {
          const full = `plugins.${def.name}.${String(key)}`
          const before = rec.settings.length
          rec.settings = rec.settings.filter(x => x.key !== full)
          if (rec.settings.length !== before) void syncPluginSettings()
          return rec.settings.length !== before
        },
        groups: () => rec.groups,
        fields: () => rec.settings,
        // 产线权限拓展面(SDK ctx.permissions):插件可查询/管理用户×产线授权
        permissions: {
          lineMode: (user, lineId) => permissions.lineMode(user, lineId),
          visibleLineIds: user => permissions.visibleLineIds(user),
          listGrants: userId => userRepository.listGrants(userId),
          setGrants: (userId, entries, grantedBy = 'plugin') => {
            for (const g of (entries ?? [])) {
              if (!g?.lineId) continue
              userRepository.setGrant(userId, String(g.lineId), (g.mode ?? null), grantedBy)
            }
            permissions.notifyGrantsChanged(userId)
            return userRepository.listGrants(userId)
          },
        },
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
        /** 时序查询直通(queryTagged):插件免鉴权拉取产线/节点窗口样本(bucket/raw),诊断取数用 */
        query: async (q) => {
          const m = await import('@/server/services/workshop/daq/storage/index')
          return m.getTsdb().queryTagged(q)
        },
        /** 数采节点元数据快照(含产线归属,插件定位某产线的全部节点) */
        nodes: async () => {
          const m = await import('@/server/services/workshop/daq/daq-node.repo')
          return m.getDaqNodeRepo().snapshot()
        },
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
      // 后端运行时对象面:ctx.services.get('daq'|'lines'|'channels'|'plugins') /
      // ctx.services.provide(name, getter) 跨插件供服务(自动 <plugin>. 前缀)
      ctx.services = {
        names: () => servicesExt.names(),
        get: name => servicesExt.get(name),
        provide: (name, get) => servicesExt.provide(def.name, name, get),
      }

      // 先 setup 再注册路由:反过来会在 setup 抛错时留下"路由活着、host.plugins 无记录"的幽灵路由,
      // 而 doReload 的清退以 host.plugins.keys() 为准 → 该插件的 omp 工具与路由永久泄漏(不可回收)。
      await def.setup?.(ctx)
      for (const r of (Array.isArray(def.routes) ? def.routes : [])) {
        emitter.registerRoute(def.name, r.method ?? 'GET', r.path, r.handler)
      }

      host.plugins.set(def.name, rec)
      host.logger.info(`✔ 已装载 [${scope}] ${def.name}@${rec.version}${rec.clientPath ? ' (+client)' : ''}`)
    }
    catch (err) {
      // setup/注册失败:逐项回滚已产生的半注册状态,保证"要么完整装载,要么完全无痕"
      rollbackPartialLoad(host, def?.name)
      host.failures.push({ source: entry, error: err?.message ?? String(err) })
      host.logger.error(`装载失败 ${entry}:`, err?.message ?? err)
    }
  }

  host.initedAt = new Date().toISOString()
  await host.bus.emit('plugin:host:init', { plugins: [...host.plugins.keys()], failures: host.failures.length })
  host.logger.info(`装载完成: ${host.plugins.size} 个(含停用)/ ${host.failures.length} 失败 / 活跃路由 ${host.routes.size} 条`)
}

/**
 * 回滚一次失败的插件装载 —— 保证「要么完整装载,要么完全无痕」。
 * 覆盖 setup 抛错 / 路由注册抛错两条路径:路由、disposables、hookOffs、omp 待注入工具、服务注册
 * 全部按插件名回收,避免出现「路由活着但 host.plugins 无记录」的幽灵态
 * (doReload 以 host.plugins.keys() 为清退依据,漏掉即永久泄漏)。
 */
function rollbackPartialLoad(host, name) {
  if (!name) return
  try {
    const removed = host.routes.unregisterPlugin?.(name) ?? 0
    const disposables = host.disposables.get(name) ?? []
    for (const d of disposables.splice(0)) {
      try {
        d?.()
      }
      catch (e) {
        host.logger.warn(`[插件回滚] dispose 失败 ${name}:`, e?.message ?? e)
      }
    }
    host.disposables.delete(name)
    for (const off of (host.hookOffs.get(name) ?? []).splice(0)) {
      try {
        off?.()
      }
      catch { /* 解绑失败不影响回滚 */ }
    }
    host.hookOffs.delete(name)
    // omp 桥:把已入 pending 未注入的工具摘掉(bridge 未挂载时为空操作)
    const bridge = globalThis.__ompPluginToolsBridge
    if (bridge?.pending) {
      bridge.pending = bridge.pending.filter(p => p.plugin !== name)
    }
    host.plugins.delete(name)
    // 设置的描述符与配置分组都挂在 rec 上 → 随 rec 一并消失;重算一次让设置页立即收敛
    void syncPluginSettings()
    if (removed > 0) host.logger.warn(`[插件回滚] ${name}:已卸下 ${removed} 条半注册路由`)
  }
  catch (e) {
    host.logger.error(`[插件回滚] ${name} 回滚自身异常:`, e?.message ?? e)
  }
}

function selfOriginRef(host) {
  return host.selfOrigin()
}

/** 插件设置声明 + 配置分组声明 → SystemConfigService
 *  (合并进平台描述符:前端设置页渲染 + PATCH 校验 + 热生效;分组供设置页分区渲染) */
async function syncPluginSettings() {
  try {
    const { getSystemConfigService } = await import('@/server/services/system-config')
    const host = getPluginHost()
    const descs = []
    const groups = []
    const labels = new Map()
    for (const rec of host?.plugins.values() ?? []) {
      if (rec.enabled === false) continue
      labels.set(rec.name, rec.label ?? rec.name)
      descs.push(...(rec.settings ?? []))
      groups.push(...(rec.groups ?? []))
    }
    getSystemConfigService().setPluginDescriptors(descs, groups, labels)
  }
  catch (err) {
    hostLoggerFallback()?.warn('插件设置同步失败(设置页将不渲染插件配置):', err?.message)
  }
}

/** 热重载:全部 dispose/解绑 → 重新装载(跳过停用)→ 广播 plugins.reloaded(并发合并)。
 *  竞态防护:重装载期间状态文件再变化(如 disable→enable 连击)时,去抖回调会撞上
 *  in-flight 守卫被吞 —— 装载结束后比对禁用集快照,有差异自动补跑一次,事件绝不丢失。 */
export async function reloadPluginHost() {
  const host = getPluginHost()
  if (!host) return null
  if (host.reloadInFlight) return host.reloadInFlight
  host.reloadInFlight = doReload(host).finally(() => {
    host.reloadInFlight = null
    try {
      const current = readDisabledSet(modePaths(host.cwd).homeDir)
      const prev = host.lastDisabledSnapshot
      const drifted = prev
        ? (current.size !== prev.size || [...current].some(x => !prev.has(x)))
        : false
      host.lastDisabledSnapshot = current
      if (drifted) void reloadPluginHost()
    }
    catch { /* 快照比对失败忽略(下个事件兜底) */ }
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
  const prevNames = [...host.plugins.keys()]
  // 卸载即注销其注册的全部 agent 工具(否则停用插件后工具仍残留在注册表、可被继续调用)
  const ompTools = await import('@/server/services/workshop/agents/plugin-tools').catch(() => null)
  for (const prev of prevNames) {
    try {
      ompTools?.unregisterPluginTools(prev)
    }
    catch { /* 注销失败不阻断重载 */ }
  }
  host.plugins.clear()
  host.routes = createRouteTable()
  host.failures = []
  await loadAllPlugins(host, { config: host.config, settingsPath: null, paths: { home: modePaths(host.cwd).homeDir, configRoot: join(host.cwd, '.AgentWorkShop'), dataDir: join(host.cwd, '.AgentWorkShop', 'data') } })
  // 装载中途失败(setup 抛错)的插件可能留下半注册工具,兜底再清一次
  for (const prev of prevNames) {
    if (!host.plugins.has(prev)) {
      try {
        ompTools?.unregisterPluginTools(prev)
      }
      catch { /* 忽略 */ }
    }
  }
  await host.bus.emit('plugins:reloaded', { plugins: pluginManifest() })
  await syncPluginSettings()
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

/** 状态文件监视 → 热重载(CLI/Web 只写文件,服务自感知)。
 *  双保险:fs.watch 的 rename 事件在 Windows 上可能丢名字/丢事件(tmp+rename 原子写
 *  尤其如此)→ 另设 10s 轮询比对 mtime,确保启停/热重载事件绝不丢失。 */
function ensureStateWatcher(host) {
  const statePath = statePathFor(modePaths(host.cwd).homeDir)
  let lastMtime = 0
  let debounce = null
  const onChange = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      void reloadPluginHost()
    }, 400)
  }
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    if (!existsSync(statePath)) writeDisabledSet(modePaths(host.cwd).homeDir, new Set())
    lastMtime = existsSync(statePath) ? statSync(statePath).mtimeMs : 0
    // watch 目录而非文件:writeDisabledSet 用 rename 原子替换,POSIX 的文件级
    // watch 挂在旧 inode 上,首次启停后静默失效;目录监听对 rename 稳定
    watch(dirname(statePath), (_event, filename) => {
      if (filename && filename !== 'plugins-state.json') return
      onChange()
    })
  }
  catch (err) {
    host.logger.warn('状态文件监视不可用(启停需手动重启):', err?.message)
  }
  // 轮询兜底(与 watch 互冗余;reloadPluginHost 幂等且并发合并)
  const poll = setInterval(() => {
    try {
      if (!existsSync(statePath)) return
      const m = statSync(statePath).mtimeMs
      if (m !== lastMtime) {
        lastMtime = m
        onChange()
      }
    }
    catch { /* 文件正被替换:下一轮再看 */ }
  }, 10_000)
  poll.unref?.()
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
  // 必须用 isPathInside:startsWith 会把兄弟同前缀目录(…/foo-evil)判为在内,可被 ../ 逃逸
  if (!isPathInside(rec.dir, rec.clientPath)) return { status: 400 }
  return { status: 200, code: readFileSync(rec.clientPath, 'utf8'), contentType: 'text/javascript; charset=utf-8' }
}

/** 清单(非敏感只读;含启停状态与路由)。builtin = 随项目检出提供的内置示例插件 */
export function pluginManifest() {
  const host = getPluginHost()
  if (!host) return []
  return [...host.plugins.values()].map(r => ({
    name: r.name,
    version: r.version,
    description: r.description,
    scope: r.scope,
    builtin: r.scope === 'project' || r.scope === 'builtin',
    enabled: r.enabled !== false,
    hasClient: Boolean(r.clientPath),
    hasI18n: Boolean(r.i18nPath),
    settingsCount: Array.isArray(r.settings) ? r.settings.length : 0,
    /** 本插件声明的配置分组(设置页独立分区;id 已收敛进 plugin-<name> 命名空间) */
    configGroups: (Array.isArray(r.groups) ? r.groups : []).map(g => ({
      id: g.id,
      label: g.label,
      fieldCount: (r.settings ?? []).filter(d => d.group === g.id).length,
    })),
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
