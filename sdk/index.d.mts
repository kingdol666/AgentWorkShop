// AgentWorkShop SDK 类型声明(agentworkshop/sdk)
// 注意:此处的 HookBus 为本文件内联声明(对应运行时 sdk/hooks.mjs),
// 不存在 sdk/hooks.d.mts,故不得 import type from './hooks.mjs'(悬空引用)。

export declare const SDK_VERSION: string
/** Twin SDK 的 canonical global bridge key(服务端 Registry 与插件宿主共享)。 */
export declare const TWIN_BRIDGE_KEY: '__twinPluginExt'

/** ctx.twin 查询面不可用时的可识别错误;注册面会先进入 pending 队列。 */
export declare class TwinRegistryUnavailableError extends Error {
  readonly name: 'TwinRegistryUnavailableError'
  readonly code: 'TWIN_REGISTRY_UNAVAILABLE'
  readonly operation: string
  constructor(operation?: string)
}

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

/** 资源面公共形状 —— 对应 sdk/api.mjs 的 `resource(root)`,每个资源都有完整五项。
 *  (旧版声明只写了 list/create,导致 `api.products.update()` 等运行时可用、TS 却报错。) */
export interface CrudResource {
  list(query?: Record<string, unknown>): Promise<any>
  get(id: string): Promise<any>
  create(body: unknown): Promise<any>
  update(id: string, patch: unknown): Promise<any>
  remove(id: string): Promise<any>
}

/** 平台 REST 客户端(SDK 作为项目服务 client 的门面)
 *  自动携带 Bearer token、自动解信封 `{code,message,data} → data`;
 *  非 2xx 或信封 `code !== 0` 均抛错(错误上带 `status` / `code` / `body`)。 */
export interface PlatformClient {
  call<T = any>(method: string, path: string, body?: unknown, opt?: { timeoutMs?: number, headers?: Record<string, string> }): Promise<T>
  get<T = any>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T = any>(path: string, body?: unknown): Promise<T>
  patch<T = any>(path: string, body?: unknown): Promise<T>
  delete<T = any>(path: string): Promise<T>
  setToken(token: string | null): PlatformClient
  /** 存活探测(免鉴权;GET /api/plugins/manifest) */
  ping(): Promise<any>
  users: CrudResource & { login(email: string, password: string): Promise<any>, me(): Promise<any> }
  lines: CrudResource & { start(id: string, recipeId?: string): Promise<any>, stop(id: string): Promise<any> }
  products: CrudResource
  recipes: CrudResource
  dcwNodes: CrudResource
  daqNodes: CrudResource & { alarms(): Promise<any> }
  templates: { daq(): Promise<any[]>, dcw(): Promise<any[]> }
  twins: CrudResource
  teams: CrudResource
  agents: CrudResource
  channels: CrudResource
  /** 产线授权面(admin):overview() 全量总览,set() 批量写 { userId, grants:[{lineId,mode}] } */
  permissions: { overview(): Promise<any>, set(payload: unknown): Promise<any> }
  plugins: { manifest(): Promise<any> }
}

/** `config:changed` 载荷(host.mjs relayConfigEvents) */
export interface ConfigChangedPayload {
  type: 'config:changed'
  /** 变更的顶层键 */
  changed?: string[]
  /** 合并后的有效配置快照 */
  effective?: Record<string, any>
  /** 各键来源(config.yml / runtime / env) */
  sources?: Record<string, string>
}

/** 插件自带设置字段声明(manifest `settings[]`,等价于运行时 ctx.config.defineField)
 *  校验规则(host.mjs setPluginSettings / context.mjs validatePluginSettings):
 *  key 需匹配 /^[A-Za-z0-9_-]+$/;type 必须是下列四种之一;**default 必填**,否则整条跳过并告警;
 *  select 的 options 必须包含 default;min/max 仅对 number 生效;label 与 labelKey 至少给一个。 */
export interface PluginSettingDecl {
  key: string
  type: 'string' | 'number' | 'boolean' | 'select'
  /** 必填:缺失的条目会被静默跳过(仅告警),不会出现在设置页 */
  default: unknown
  min?: number
  max?: number
  options?: string[]
  /** i18n 键(形如 plugin.<name>.<key>);与 label 至少给一个 */
  labelKey?: string
  label?: string
  description?: string
  /** 归属分组 id(引用同一 manifest 的 configGroups[].id) */
  group?: string
}

/** 插件自带配置分组声明 —— **manifest 字段名是 `configGroups`**(host.mjs `def.configGroups`),
 *  写成 `groups` 会被静默忽略。两个内置插件(rag-bridge / diag-bridge)均用 `configGroups`。 */
export interface PluginGroupDecl {
  id: string
  /** 与 labelKey 至少给一个(validatePluginGroups 取 label ?? labelKey) */
  label?: string
  labelKey?: string
  description?: string
  order?: number
  collapsed?: boolean
}

/** 宿主注入的扩展面 —— 不在 sdk/context.mjs 内,由插件宿主 host.mjs 在 setup 前挂载。
 *  类型在此内联声明,使 TS 插件作者无需宿主类型包即可获得提示。 */
export interface PluginHostExtensions {
  /** 数采扩展面(host.mjs):注册驱动/处理器/模板 + 帧订阅 + 免鉴权时序查询 */
  daq?: {
    registerDriver(driver: unknown): boolean
    registerProcessor(kind: string, name: string, fn: (frame: any) => any): boolean
    registerTemplate(def: unknown): boolean
    onFrame(fn: (payload: any) => any): () => void
    onSample(fn: (payload: any) => any): () => void
    query(q: { nodeIds?: string[], lineId?: string, from?: number, to?: number, bucketMs?: number }): Promise<any>
    nodes(): Promise<any>
  }
  /** Agent 工具注入面:注册的 host 工具热注入全部 harness 的会话(受团队插件开关过滤) */
  omp?: {
    registerTool(tool: {
      name: string
      label?: string
      description?: string
      parameters?: Record<string, unknown>
      roles?: string[]
      handler: (args: any, ctx?: any) => any
    }): void
  }
  /** 后端运行时对象面:只读取数 + 跨插件服务(provide 自动加 `<plugin>.` 前缀) */
  services?: {
    names(): string[]
    get<T = any>(name: string): Promise<T>
    provide(name: string, getter: () => any): void
  }
}

/** Twin Registry 全局桥使用的注册类别(注册在 Registry 未加载时会排队)。 */
export type TwinRegistrationKind =
  | 'registerPhysicsProvider'
  | 'registerScenePack'
  | 'registerObjectiveProfile'
  | 'registerTrainingAdapter'
  | 'registerSolverAdapter'

/** SDK 自动附带的插件来源信息,服务端 Registry 用于 lineage / hot-reload 清理。 */
export interface TwinRegistrationSource {
  plugin: string
  pluginName?: string
  /** 与 plugin 相同的兼容别名(旧桥实现可能读取 name) */
  name?: string
  scope?: 'builtin' | 'project' | 'user' | string
  dir?: string
  version?: string
  sdkVersion?: string
  [key: string]: unknown
}

/** 注册项在 Registry 尚未接管时的 pending 形态。 */
export interface TwinPendingRegistration {
  kind: TwinRegistrationKind
  payload: unknown
  source: TwinRegistrationSource
}

/** 注册未立即交给 Registry 时返回的确认对象。 */
export interface TwinRegistrationReceipt {
  status: 'queued'
  queued: true
  kind: TwinRegistrationKind
  plugin: string
  source: TwinRegistrationSource
}

/** Provider 查询过滤条件由服务端 Registry 解释,SDK 保持向前兼容。 */
export interface TwinProviderFilter {
  providerId?: string
  version?: string
  sceneKind?: string
  scenePackId?: string
  status?: string
  capability?: string
  [key: string]: unknown
}

/** Provider 健康结果由服务端返回;保留扩展字段以兼容后续 health contract。 */
export interface TwinProviderHealth {
  providerId?: string
  version?: string
  status?: string
  healthy?: boolean
  [key: string]: unknown
}

/**
 * SDK 不冻结 Provider/Scene/Objective 的业务字段,只给常见能力提供可选提示。
 * 详细 contract 由服务端 Registry 校验,这样旧插件和未来 schema 可以共存。
 */
export interface TwinPhysicsProvider {
  manifest?: (...args: any[]) => any
  validateScene?: (...args: any[]) => any
  initialize?: (...args: any[]) => any
  step?: (...args: any[]) => any
  simulate?: (...args: any[]) => any
  calibrate?: (...args: any[]) => any
  health?: (...args: any[]) => any
  [key: string]: unknown
}

export interface TwinScenePack {
  sceneKind?: string
  sceneSchemaVersion?: string
  discover?: (...args: any[]) => any
  compile?: (...args: any[]) => any
  [key: string]: unknown
}

export interface TwinObjectiveProfile {
  id?: string
  version?: string
  [key: string]: unknown
}

export interface TwinSolverAdapter {
  id?: string
  version?: string
  inputSchema?: unknown
  outputSchema?: unknown
  run?: (...args: any[]) => any
  cancel?: (...args: any[]) => any
  health?: (...args: any[]) => any
  [key: string]: unknown
}

/** Registry 调用可能是同步或异步;具体结果由服务端 contract 决定。 */
export type TwinRegistryResult<T = any> = T | Promise<T>

/**
 * 全局桥契约(服务端 Registry 可直接实现,也可只实现其中的兼容形态)。
 * 插件作者通常不需要直接使用它;该接口主要用于 Registry / 集成测试。
 */
export interface TwinRegistryBridge {
  pending?: TwinPendingRegistration[]
  register?(kind: TwinRegistrationKind, payload: unknown, source: TwinRegistrationSource): TwinRegistryResult<any>
  registerEntry?(entry: TwinPendingRegistration): TwinRegistryResult<any>
  enqueue?(kind: TwinRegistrationKind, payload: unknown, source: TwinRegistrationSource): TwinRegistryResult<any>
  queue?(kind: TwinRegistrationKind, payload: unknown, source: TwinRegistrationSource): TwinRegistryResult<any>
  drain?(onEntry: (entry: TwinPendingRegistration) => any): void
  attach?(registry: unknown): TwinRegistryBridge
  bind?(registry: unknown): TwinRegistryBridge
  call?(method: string, ...args: any[]): TwinRegistryResult<any>
  invoke?(method: string, ...args: any[]): TwinRegistryResult<any>
  dispatch?(method: string, ...args: any[]): TwinRegistryResult<any>
  registry?: Record<string, any> | null
  unregisterPlugin?(source: TwinRegistrationSource | string): number | void
  removePlugin?(source: TwinRegistrationSource | string): number | void
  [key: string]: any
}

/** ctx.twin:插件向服务端 Twin Provider Registry 暴露的稳定 SDK 面。 */
export interface TwinPluginApi {
  registerPhysicsProvider(provider: TwinPhysicsProvider | unknown): TwinRegistryResult<any>
  registerScenePack(pack: TwinScenePack | unknown): TwinRegistryResult<any>
  registerObjectiveProfile(profile: TwinObjectiveProfile | unknown): TwinRegistryResult<any>
  registerTrainingAdapter(adapter: unknown): TwinRegistryResult<any>
  registerSolverAdapter(adapter: TwinSolverAdapter | unknown): TwinRegistryResult<any>
  listProviders(filter?: TwinProviderFilter): TwinRegistryResult<any[]>
  getProviderHealth(providerId: string, version?: string): TwinRegistryResult<TwinProviderHealth | any>
  resolveProvider(providerId: string, version?: string): TwinRegistryResult<any>
  validateProvider(providerId: string, version?: string): TwinRegistryResult<any>
  retireProvider(providerId: string, version?: string): TwinRegistryResult<any>
  isRegistryAvailable(): boolean
}

export interface PluginContext extends PluginHostExtensions {
  name: string
  /** 插件来源作用域(host.mjs discoverPluginDirs:builtin / project / user) */
  scope: 'builtin' | 'project' | 'user'
  dir: string
  sdkVersion: string
  hooks: HookBus
  logger: PluginLogger
  config: {
    get(key: string): any
    all(): Record<string, any>
    onChange(fn: (payload?: ConfigChangedPayload) => any): () => void
    /** 声明式注册本插件专属配置分组(id 收敛进 plugin-<name> 命名空间,卸载自动摘除) */
    defineGroup(def: PluginGroupDecl): void
    /** 声明式注册配置字段(等价 manifest settings[],key 自动编址 plugins.<name>.<key>) */
    defineField(decl: PluginSettingDecl): void
    removeGroup(id: string): void
    removeField(key: string): void
    /** 本插件当前已注册的分组 / 字段(只读快照) */
    groups(): PluginGroupDecl[]
    fields(): PluginSettingDecl[]
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
  /** 产线权限拓展面(用户 × 产线三态授权: none / readonly / operate) */
  permissions: {
    lineMode(user: { id: string, role: string }, lineId: string | null | undefined): 'none' | 'readonly' | 'operate'
    visibleLineIds(user: { id: string, role: string }): Set<string> | null
    listGrants(userId: string): Array<{ lineId: string, mode: string, grantedBy: string | null, grantedAt: string }>
    setGrants(userId: string, grants: Array<{ lineId: string, mode: 'readonly' | 'operate' | null }>, grantedBy?: string): Array<{ lineId: string, mode: string }>
  }
  api: PlatformClient
  http: PluginHttp
  events: { on(type: string, fn: (payload: any) => any): () => void, off(type: string, fn: (payload: any) => any): void }
  twin: TwinPluginApi
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
  /** 插件 API 转发层鉴权:none(默认)| user | admin | agent-or-user(host.mjs registerRoute) */
  auth?: 'none' | 'user' | 'admin' | 'agent-or-user' | string
  /** 自带设置声明:宿主并入 SystemConfigService,设置页按分组渲染 */
  settings?: PluginSettingDecl[]
  /** 自带配置分组声明(settings[].group 引用其 id)。
   *  ⚠️ 字段名就是 configGroups —— 宿主读的是 def.configGroups,写 `groups` 无效。 */
  configGroups?: PluginGroupDecl[]
  setup?(ctx: PluginContext): void | Promise<void>
  client?: string
  routes?: PluginRouteDef[]
}

/** 显式糖:类型化定义插件(宿主同样接受裸对象导出) */
export declare function definePlugin(def: PluginDef): PluginDef

export declare function createPluginContext(opts: Record<string, any>): PluginContext
export declare function getTwinRegistryBridge(preferred?: unknown): TwinRegistryBridge
export declare function createRouteTable(): {
  register(name: string, method: string, path: string, handler: (event: any) => any): boolean
  resolve(name: string, method: string, path: string): ((event: any) => any) | null
  byPlugin(name: string): Array<{ method: string, path: string }>
  readonly size: number
}
export declare function validatePluginModule(mod: any, source: string): { ok: boolean, def?: PluginDef, error?: string }
export declare function pluginKvExists(dataDir: string, name: string): boolean

/** 路径包含判定(插件目录越界防护;同前缀兄弟目录不会被误放行) */
export declare function isPathInside(dir: string, p: string): boolean
/** 把插件声明的分组 id 收敛进 plugin-<name>[-<suffix>] 命名空间;非法 id 回落到主分组 */
export declare function resolvePluginGroupId(pluginName: string, declaredId?: string): string
/** 校验 manifest.configGroups;返回 { groups, errors }(无 ok 字段 —— 只看 groups.length) */
export declare function validatePluginGroups(pluginName: string, defs: unknown): { groups: PluginGroupDecl[], errors: string[] }
/** 校验 manifest.settings;default 缺失的条目会被跳过并记入 errors */
export declare function validatePluginSettings(pluginName: string, defs: unknown, opts?: { defaultGroup?: string }): { descriptors: PluginSettingDecl[], errors: string[] }

export declare function createPlatformClient(opts?: { baseUrl?: string, token?: string, logger?: PluginLogger, timeoutMs?: number }): PlatformClient

export declare const LIFECYCLE_EVENTS: readonly ['plugin:host:init', 'plugins:reloaded', 'config:changed', 'event:permissions:changed', 'event:*', 'daq:sample', 'daq:frame', 'dcw:write', 'line:start', 'line:stop', 'server:close']
export declare const CLIENT_EVENTS: readonly ['client:init', 'event:*', 'page:change', 'i18n:changed', 'client:destroy']

/** 客户端插件上下文(sdk/client.mjs);完整声明见 agentworkshop/sdk/client */
export declare const CLIENT_SDK_VERSION: string
/** DOM 构建助手(client.mjs 的具名导出,经本包再导出) */
export declare function el(tag: string, attrs?: Record<string, unknown>, children?: Array<Node | string> | Node | string): HTMLElement

/** ctx.ui.registerPanel 入参(命名插槽 -> 宿主容器挂载) */
export interface ClientPanelEntry {
  slot: string
  name: string
  title?: string
  titleKey?: string
  order?: number
  mount(el: HTMLElement): void
}

/** ctx.ui:UI 注入面(宿主未提供时为告警桩) */
export interface ClientUi {
  registerPanel(entry: ClientPanelEntry): () => void
  readonly slots: readonly string[]
}

export interface ClientContext {
  name: string
  sdkVersion: string
  hooks: HookBus
  on(type: string, fn: (payload: any) => any): () => void
  fetch<T = any>(path: string, opt?: { method?: string, body?: unknown, headers?: Record<string, string> }): Promise<T>
  el(tag: string, attrs?: Record<string, unknown>, children?: Array<Node | string>): HTMLElement
  mount(target: string | Element, node: Node): Node
  root(): HTMLElement
  /** UI 注入面:registerPanel / slots */
  ui: ClientUi
  /** 插件命名空间翻译:ctx.t('settings.title') -> plugin.<name>.settings.title */
  t(key: string, params?: Record<string, unknown>): string
  /** 当前界面语言(i18n:changed 钩子在切换时广播;未注入时 '') */
  readonly locale: string
  log: PluginLogger
  dispose(): void
}
export declare function createClientContext(opts?: {
  name: string
  eventBridge?: (fn: (type: string, payload: any) => void) => (() => void)
  baseUrl?: string
  ui?: ClientUi
  t?: (key: string, params?: Record<string, unknown>) => string
  getLocale?: () => string
}): ClientContext

declare const _default: Record<string, unknown>
export default _default
