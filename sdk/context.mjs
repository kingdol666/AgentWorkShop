// ============================================================
// AgentWorkShop SDK — 服务端插件上下文工厂（宿主调用;插件经 setup(ctx) 获得）
// ------------------------------------------------------------
// ctx 形态(运行时完整变量面):
//   身份    ctx.name / ctx.scope('home'|'project') / ctx.dir / ctx.sdkVersion
//   钩子    ctx.hooks   HookBus(生命周期 + event:*)                  [SDK]
//   日志    ctx.logger  { debug, info, warn, error } 插件名前缀      [SDK]
//   配置    ctx.config  { get(key), all(), onChange(fn) }            [SDK]
//   存储    ctx.kv      { get,set,all,bump } 内存态+防抖落盘          [SDK]
//   定时    ctx.timer   { setInterval, setTimeout } 服务关闭自动回收  [SDK]
//   清理    ctx.onDispose(fn) / ctx.subscriptions                    [SDK]
//   路由    ctx.route(method, path, handler) → /api/plugins/<name>… [SDK]
//   平台    ctx.api     平台 REST 客户端(lines/daq/dcw/twins/teams…) [SDK]
//   网络    ctx.http    { get, post } 带超时 fetch(仅 http/https)    [SDK]
//   事件    ctx.events  { on(type,fn), off }  scene 实时事件          [SDK]
//   路径    ctx.paths   { home, configRoot, dataDir }                [SDK]
// ============================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HookBus } from './hooks.mjs'
import { createPlatformClient } from './api.mjs'

export const SDK_VERSION = '0.3.0'

/** 允许的对外请求协议守卫(拒绝 file:/data: 等;宿主/插件同守此规则) */
function safeUrl(raw, timeoutMs = 8000) {
  const u = new URL(String(raw))
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`协议不允许: ${u.protocol}(仅 http/https)`)
  return { signal: AbortSignal.timeout(timeoutMs) }
}

/**
 * 创建服务端插件上下文。
 * @param {{ name, scope, dir, hooks, logger, config, paths, emitter, onDispose, selfOrigin }} opts 宿主装配
 */
export function createPluginContext(opts) {
  const { name, scope, dir, hooks, config, paths, emitter } = opts
  // 规范化 logger:宿主实现缺级时兜底 no-op(插件可用全套 debug/info/warn/error)
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    ...(opts.logger ?? {}),
  }

  // ---- 订阅回收(VSCode subscriptions 范式):服务关闭时宿主逐个调用 ----
  const disposables = []
  const onDispose = (fn) => {
    if (typeof fn === 'function') disposables.push(fn)
    return fn
  }

  // ---- 定时器:自动登记回收,杜绝插件定时器泄漏 ----
  const timer = {
    setInterval: (fn, ms, ...rest) => {
      const id = setInterval(fn, ms, ...rest)
      if (typeof id === 'object' && id !== null && 'unref' in id) id.unref?.()
      onDispose(() => clearInterval(id))
      return id
    },
    setTimeout: (fn, ms, ...rest) => {
      const id = setTimeout(fn, ms, ...rest)
      if (typeof id === 'object' && id !== null && 'unref' in id) id.unref?.()
      onDispose(() => clearTimeout(id))
      return id
    },
  }

  // ---- 插件私有持久化:内存态为准 + 200ms 防抖落盘 —— 高频钩子(daq:sample)
  //      与低频钩子(line:stop)并发时无 read-modify-write 竞态(JS 同步内存操作原子) ----
  const kvDir = join(paths.dataDir, 'plugins', name)
  const kvFile = join(kvDir, 'kv.json')
  const kvState = (() => {
    try {
      return JSON.parse(readFileSync(kvFile, 'utf8'))
    }
    catch {
      return {}
    }
  })()
  let kvFlushTimer = null
  const kvFlush = () => {
    clearTimeout(kvFlushTimer)
    kvFlushTimer = setTimeout(() => {
      try {
        mkdirSync(kvDir, { recursive: true })
        const tmp = `${kvFile}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify(kvState, null, 2)}\n`, 'utf8')
        renameSync(tmp, kvFile)
      }
      catch { /* 磁盘异常不阻断插件 */ }
    }, 200)
  }

  const ctx = {
    name,
    scope,
    dir: resolve(dir),
    sdkVersion: SDK_VERSION,
    hooks, // 宿主全局总线(与事件桥同源)
    logger,
    config: {
      get: key => config?.effective?.[key],
      all: () => ({ ...config?.effective }),
      /** 运行时覆盖变更订阅(runtime-settings.json 变化;宿主 fs.watch 驱动) */
      onChange: fn => hooks.on('config:changed', fn),
    },
    paths: { ...paths },
    dataDir: kvDir,
    kv: {
      get: key => kvState[key],
      set: (key, value) => {
        kvState[key] = value
        kvFlush()
        return value
      },
      all: () => ({ ...kvState }),
      bump: (key, by = 1) => {
        kvState[key] = (Number(kvState[key]) || 0) + by
        kvFlush()
        return kvState[key]
      },
    },
    timer,
    onDispose,
    /** 订阅式清理对象({ dispose(){} })集中登记 */
    subscriptions: {
      add: (d) => {
        disposables.push(typeof d === 'function' ? d : (...a) => d.dispose?.(...a))
        return d
      },
    },
    route: (method, path, handler) => emitter?.registerRoute(name, method, path, handler),
    /** 平台 REST 客户端(自环 origin 延迟解析;鉴权端点请 ctx.api.setToken(token)) */
    api: createPlatformClient({
      baseUrl: typeof opts.selfOrigin === 'function' ? opts.selfOrigin : () => opts.selfOrigin,
      logger,
    }),
    http: {
      get: (url, opts2 = {}) => fetch(url, { ...safeUrl(url, opts2.timeoutMs), ...opts2 }),
      post: (url, body, opts2 = {}) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts2.headers ?? {}) },
        body: JSON.stringify(body ?? {}),
        ...safeUrl(url, opts2.timeoutMs),
      }),
    },
    events: {
      on: (type, fn) => hooks.on(type === '*' ? '*' : `event:${type}`, fn),
      off: (type, fn) => hooks.off(type === '*' ? '*' : `event:${type}`, fn),
    },
  }
  return ctx
}

/** 宿主路由表(exact-match;插件 API 挂 /api/plugins/<name><path>) */
export function createRouteTable() {
  const table = new Map() // `${method} ${name} ${path}` → handler
  return {
    register(name, method, path, handler) {
      if (typeof handler !== 'function') return false
      const key = `${String(method).toUpperCase()} ${name} ${path.startsWith('/') ? path : `/${path}`}`
      table.set(key, handler)
      return true
    },
    resolve(name, method, path) {
      return table.get(`${String(method).toUpperCase()} ${name} ${path.startsWith('/') ? path : `/${path}`}`) ?? null
    },
    byPlugin(name) {
      const out = []
      for (const key of table.keys()) {
        const [m, n, ...rest] = key.split(' ')
        if (n === name) out.push({ method: m, path: rest.join('/') })
      }
      return out
    },
    get size() {
      return table.size
    },
  }
}

/** 校验插件入口导出(宿主装载前的形态检查) */
export function validatePluginModule(mod, source) {
  const def = mod?.default ?? mod
  if (!def || typeof def !== 'object' || typeof def.name !== 'string' || !def.name.trim()) {
    return { ok: false, error: `插件缺少 name 或不是对象: ${source}` }
  }
  if (def.setup && typeof def.setup !== 'function') {
    return { ok: false, error: `插件 setup 不是函数: ${def.name}` }
  }
  if (def.client && typeof def.client !== 'string') {
    return { ok: false, error: `插件 client 必须是相对路径字符串: ${def.name}` }
  }
  return { ok: true, def }
}

/** 便捷:SDK 侧 definePlugin(纯类型糖;宿主同样接受裸对象) */
export function definePlugin(def) {
  const check = validatePluginModule({ default: def }, def?.name ?? '(anonymous)')
  if (!check.ok) throw new Error(check.error)
  return def
}

/** 插件 KV 目录探测(存在性只读) */
export function pluginKvExists(dataDir, name) {
  return existsSync(join(resolve(dataDir), 'plugins', name, 'kv.json'))
}

export default {
  SDK_VERSION,
  HookBus,
  createPluginContext,
  createRouteTable,
  validatePluginModule,
  definePlugin,
}
