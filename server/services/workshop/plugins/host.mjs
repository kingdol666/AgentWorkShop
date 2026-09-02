// ============================================================
// AgentWorkShop 插件宿主 —— 发现 / 装载 / 生命周期 / 路由表
// ------------------------------------------------------------
// 目录(与 aw commands 同哲学):
//   project: <repo>/.AgentWorkShop/plugins/<name>/index.mjs
//   user:    ~/.AgentWorkShop/plugins/<name>/index.mjs(同名 project 优先)
// 契约:入口导出普通对象 { name, version?, description?, setup(ctx)?,
//   client?: './client.mjs', routes?: [{method,path,handler}] }
// —— ctx 由宿主注入,插件运行时零导入依赖(sdk/ 供类型与显式糖)。
// 错误隔离:单插件装载/执行失败记入 failures,绝不拖垮主服务。
// ============================================================
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HookBus, createPluginContext, createRouteTable, validatePluginModule } from '@/sdk/index.mjs'

const g = globalThis

function log() {
  return {
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
  }
}

function pathToUrl(p) {
  return pathToFileURL(resolve(p)).href
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
 * 装载 = 动态 import 入口 → 形态校验 → createPluginContext → setup(ctx)
 *       → 收集 routes/client → emit plugin:host:init
 */
export async function initPluginHost({ cwd = process.cwd(), packageRoot } = {}) {
  if (g.__awPluginHost) return g.__awPluginHost
  const logger = log()
  const host = {
    bus: new HookBus({
      name: 'aw-plugins',
      onError: (err, meta) => logger.warn(`钩子错误(${meta?.type}):`, err?.message ?? err),
    }),
    routes: createRouteTable(),
    plugins: new Map(),
    disposables: new Map(), // name → fn[](setup 内 ctx.onDispose 登记;server:close 时回收)
    failures: [],
    initedAt: null,
    logger,
  }
  g.__awPluginHost = host

  // 有效配置(只读面;引擎/模式解析从运行根动态加载,js-yaml 由对应 node_modules 解析)
  let config = null
  let settingsPath = null
  let paths = { home: defaultHome(), configRoot: join(cwd, '.AgentWorkShop'), dataDir: join(cwd, '.AgentWorkShop', 'data') }
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
  // 自环 origin:PORT env(prod) > argv --port(dev:dev-guard 转发链天然携带) > 配置 dev 端口;
  // nitro listen 钩子(setSelfOrigin)仍保留为最终兜底
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
  host.logger.info(`自环 origin: ${selfOrigin} (PORT=${process.env.PORT ?? '∅'} NITRO_PORT=${process.env.NITRO_PORT ?? '∅'} argPort=${argPort ?? '∅'})`)

  // 配置变更监听:runtime-settings.json 变化 → 原地刷新 effective + config:changed 钩子
  if (settingsPath && existsSync(settingsPath)) {
    try {
      let debounce = null
      watch(settingsPath, () => {
        clearTimeout(debounce)
        debounce = setTimeout(async () => {
          try {
            if (host.config && existsSync(settingsPath)) {
              const homeMod = await import(pathToUrl(join(cwd, 'shared', 'config', 'home.mjs')))
              const rm = homeMod.resolveRunMode({ cwd, packageRoot, env: process.env })
              const engine = await import(pathToUrl(join((rm.mode === 'repo' ? rm.root : packageRoot ?? rm.root) ?? cwd, 'shared', 'config', 'engine.mjs')))
              const fresh = engine.loadEffective({ configPath: rm.configPath, settingsPath: rm.settingsPath, env: process.env })
              Object.assign(host.config.effective, fresh.effective)
              host.config.sources = fresh.sources
            }
            await host.bus.emit('config:changed', { at: new Date().toISOString() })
            host.logger.info('配置变更已广播(config:changed)')
          }
          catch (err) {
            host.logger.warn('config:changed 处理失败:', err?.message)
          }
        }, 300)
      })
    }
    catch { /* fs.watch 不可用时插件可经轮询自行感知 */ }
  }

  const entries = discoverPluginDirs(cwd)
  if (entries.length) host.logger.info(`发现 ${entries.length} 个插件,开始装载 ...`)

  for (const { dir, scope } of entries) {
    const entry = join(dir, 'index.mjs')
    try {
      const mod = await import(pathToUrl(entry))
      const check = validatePluginModule(mod, entry)
      if (!check.ok) throw new Error(check.error)
      const def = check.def

      if (host.plugins.has(def.name)) throw new Error(`插件重名(后装载者跳过): ${def.name}`)

      const rec = {
        name: def.name,
        version: String(def.version ?? '0.0.0'),
        description: String(def.description ?? ''),
        scope,
        dir,
        entry,
        clientPath: def.client ? resolve(dir, def.client) : null,
        routes: [],
      }

      const emitter = {
        registerRoute: (n, m, p, h) => {
          host.routes.register(n, m, p, h)
          rec.routes.push({ method: String(m).toUpperCase(), path: p })
        },
      }
      const perPluginDisposables = []
      host.disposables.set(def.name, perPluginDisposables)
      const ctx = createPluginContext({
        name: def.name,
        scope,
        dir,
        hooks: host.bus,
        logger: {
          debug: (...a) => logger.info(`[${def.name}][debug]`, ...a),
          info: (...a) => logger.info(`[${def.name}]`, ...a),
          warn: (...a) => logger.warn(`[${def.name}]`, ...a),
          error: (...a) => logger.error(`[${def.name}]`, ...a),
        },
        config,
        paths,
        emitter,
        onDispose: (fn) => {
          perPluginDisposables.push(fn)
          return fn
        },
        selfOrigin: host.selfOrigin,
      })

      // 声明式 routes + setup 内 ctx.route() 两种形态都支持
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
  host.logger.info(`装载完成: ${host.plugins.size} 成功 / ${host.failures.length} 失败 / 路由 ${host.routes.size} 条`)
  return host
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

/** 清单(非敏感只读:名称/版本/作用域/描述/路由/是否有客户端) */
export function pluginManifest() {
  const host = getPluginHost()
  if (!host) return []
  return [...host.plugins.values()].map(r => ({
    name: r.name,
    version: r.version,
    description: r.description,
    scope: r.scope,
    hasClient: Boolean(r.clientPath),
    routes: host.routes.byPlugin(r.name),
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
