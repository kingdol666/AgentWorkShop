// AgentWorkShop SDK 类型声明(agentworkshop/sdk)
import type { HookBus } from './hooks.mjs'

export declare const SDK_VERSION: string

/** 生命周期钩子总线:异步串行、错误隔离、'*' 通配、连续失败自动熔断 */
export declare class HookBus {
  constructor(opts?: { name?: string, onError?: (err: Error, meta?: { bus?: string, type?: string, fails?: number }) => void })
  on(type: string, fn: (payload: any) => any): () => void
  once(type: string, fn: (payload: any) => any): () => void
  off(type: string, fn: (payload: any) => any): void
  emit(type: string, payload?: any): Promise<any>
  readonly size: number
}

export interface PluginLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface PluginKv {
  get(key: string): any
  set(key: string, value: any): any
  all(): Record<string, any>
  bump(key: string, by?: number): number
}

export interface PluginHttp {
  get(url: string, opts?: { timeoutMs?: number, headers?: Record<string, string> }): Promise<Response>
  post(url: string, body?: unknown, opts?: { timeoutMs?: number, headers?: Record<string, string> }): Promise<Response>
}

/** 平台 REST 客户端(SDK 作为项目服务 client 的门面) */
export interface PlatformClient {
  call<T = any>(method: string, path: string, body?: unknown): Promise<T>
  get<T = any>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T = any>(path: string, body?: unknown): Promise<T>
  patch<T = any>(path: string, body?: unknown): Promise<T>
  delete<T = any>(path: string): Promise<T>
  setToken(token: string | null): PlatformClient
  ping(): Promise<any>
  users: { list(q?: any): Promise<any>, get(id: string): Promise<any>, create(b: any): Promise<any>, login(email: string, password: string): Promise<any>, me(): Promise<any> }
  lines: { list(q?: any): Promise<any>, get(id: string): Promise<any>, create(b: any): Promise<any>, update(id: string, p: any): Promise<any>, remove(id: string): Promise<any>, start(id: string, recipeId?: string): Promise<any>, stop(id: string): Promise<any> }
  products: { list(q?: any): Promise<any>, create(b: any): Promise<any> }
  recipes: { list(q?: any): Promise<any>, create(b: any): Promise<any> }
  dcwNodes: { list(q?: any): Promise<any>, create(b: any): Promise<any> }
  daqNodes: { list(q?: any): Promise<any>, create(b: any): Promise<any>, alarms(): Promise<any> }
  templates: { daq(): Promise<any[]>, dcw(): Promise<any[]> }
  twins: { list(q?: any): Promise<any>, create(b: any): Promise<any> }
  teams: { list(q?: any): Promise<any>, create(b: any): Promise<any> }
  agents: { list(q?: any): Promise<any>, create(b: any): Promise<any> }
  channels: { list(q?: any): Promise<any> }
  plugins: { manifest(): Promise<any> }
}

export interface PluginContext {
  name: string
  scope: 'project' | 'user'
  dir: string
  sdkVersion: string
  hooks: HookBus
  logger: PluginLogger
  config: {
    get(key: string): any
    all(): Record<string, any>
    onChange(fn: (payload?: { at: string }) => any): () => void
  }
  paths: { home: string, configRoot: string, dataDir: string }
  dataDir: string
  kv: PluginKv
  timer: {
    setInterval(fn: (...args: any[]) => void, ms: number, ...rest: any[]): NodeJS.Timeout
    setTimeout(fn: (...args: any[]) => void, ms: number, ...rest: any[]): NodeJS.Timeout
  }
  onDispose(fn: () => any): () => void
  subscriptions: { add(d: { dispose(): any } | (() => any)): any }
  route(method: string, path: string, handler: (event: any) => any): boolean
  api: PlatformClient
  http: PluginHttp
  events: { on(type: string, fn: (payload: any) => any): () => void, off(type: string, fn: (payload: any) => any): void }
}

export interface PluginRouteDef {
  method?: string
  path: string
  handler: (event: any) => any
}

export interface PluginDef {
  name: string
  version?: string
  description?: string
  setup?(ctx: PluginContext): void | Promise<void>
  client?: string
  routes?: PluginRouteDef[]
}

/** 显式糖:类型化定义插件(宿主同样接受裸对象导出) */
export declare function definePlugin(def: PluginDef): PluginDef

export declare function createPluginContext(opts: Record<string, any>): PluginContext
export declare function createRouteTable(): {
  register(name: string, method: string, path: string, handler: (event: any) => any): boolean
  resolve(name: string, method: string, path: string): ((event: any) => any) | null
  byPlugin(name: string): Array<{ method: string, path: string }>
  readonly size: number
}
export declare function validatePluginModule(mod: any, source: string): { ok: boolean, def?: PluginDef, error?: string }
export declare function pluginKvExists(dataDir: string, name: string): boolean

export declare function createPlatformClient(opts?: { baseUrl?: string, token?: string, logger?: PluginLogger, timeoutMs?: number }): PlatformClient

export declare const LIFECYCLE_EVENTS: readonly ['plugin:host:init', 'config:changed', 'event:*', 'daq:sample', 'dcw:write', 'line:start', 'line:stop', 'server:close']
export declare const CLIENT_EVENTS: readonly ['client:init', 'event:*', 'page:change', 'client:destroy']

/** 客户端插件上下文(sdk/client.mjs) */
export declare const CLIENT_SDK_VERSION: string
export interface ClientContext {
  name: string
  sdkVersion: string
  hooks: HookBus
  on(type: string, fn: (payload: any) => any): () => void
  fetch<T = any>(path: string, opt?: { method?: string, body?: unknown, headers?: Record<string, string> }): Promise<T>
  el(tag: string, attrs?: Record<string, unknown>, children?: Array<Node | string>): HTMLElement
  mount(target: string | Element, node: Node): Node
  root(): HTMLElement
  log: PluginLogger
  dispose(): void
}
export declare function createClientContext(opts: { name: string, eventBridge?: (fn: (type: string, payload: any) => void) => (() => void), baseUrl?: string }): ClientContext

declare const _default: Record<string, unknown>
export default _default
