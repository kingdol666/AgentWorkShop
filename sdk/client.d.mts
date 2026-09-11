// AgentWorkShop SDK 类型声明(agentworkshop/sdk/client)
// ------------------------------------------------------------
// 与 sdk/client.mjs 一一对应(浏览器侧;自包含、零框架依赖)。
// 运行时命名导出: CLIENT_SDK_VERSION, createClientContext, default
// default 额外携带模块私有的 el() 助手(命名导出不含 el)。
// 消费方通常直接 import { createClientContext } from 'agentworkshop/sdk/client'。

/** 客户端 SDK 版本(与 sdk/client.mjs CLIENT_SDK_VERSION 同步) */
export declare const CLIENT_SDK_VERSION: string

/** HookBus:异步串行、错误隔离、'*' 通配、连续失败自动熔断 */
export declare class HookBus {
  constructor(opts?: { name?: string, onError?: (err: Error, meta?: { bus?: string, type?: string, fails?: number }) => void })
  on(type: string, fn: (payload: any) => any): () => void
  once(type: string, fn: (payload: any) => any): () => void
  off(type: string, fn: (payload: any) => any): void
  emit(type: string, payload?: any): Promise<any>
  readonly size: number
}

/** ctx.log:前缀 console(前缀 [aw-plugin:<name>]) */
export interface ClientLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** ctx.ui.registerPanel 的入参(loader 注入宿主实现) */
export interface ClientPanelEntry {
  /** 目标插槽名(经 <PluginSlot slot-name> 渲染) */
  slot: string
  /** 面板名(插件内唯一) */
  name: string
  /** 面板标题(缺省时宿主回退 titleKey / name) */
  title?: string
  /** i18n 标题键(优先于 title) */
  titleKey?: string
  /** 同插槽内排序权重 */
  order?: number
  /** 渲染回调:入参为该面板的宿主容器节点 */
  mount(el: HTMLElement): void
}

/** ctx.ui:UI 注入面(宿主未提供时为告警桩) */
export interface ClientUi {
  registerPanel(entry: ClientPanelEntry): () => void
  /** 已知插槽名(宿主未提供时为 []) */
  readonly slots: readonly string[]
}

/** ctx.t 的翻译参数(占位符插值) */
export type ClientTranslateParams = Record<string, unknown>

/** ctx:客户端插件上下文(由 createClientContext 返回) */
export interface ClientContext {
  /** 插件名(与插件 def.name 一致) */
  name: string
  /** SDK 版本(= CLIENT_SDK_VERSION) */
  sdkVersion: string
  /** 客户端本地 HookBus(client:init / event:* / page:change / client:destroy) */
  hooks: HookBus
  /** scene 实时事件订阅(与 WS 同源;type='*' 通配);返回解绑函数,dispose 时自动回收 */
  on(type: string, fn: (payload: any) => any): () => void
  /** 同源平台 API 助手(JSON;自动解 {data} 信封;非 2xx 抛错;自动携带 cookie token) */
  fetch<T = any>(path: string, opt?: { method?: string, body?: unknown, headers?: Record<string, string> }): Promise<T>
  /** DOM 助手:创建元素;attrs 支持 style / class / on<event> / 其余 setAttribute */
  el(tag: string, attrs?: Record<string, unknown>, children?: Array<Node | string> | Node | string): HTMLElement
  /** 挂载节点到选择器/元素(缺失时回落 ctx.root()) */
  mount(target: string | Element, node: Node): Node
  /** 插件 UI 挂载点(懒创建,自动附加到 body,#aw-plugin-<name>) */
  root(): HTMLElement
  /** UI 注入面(loader 注入;脱离宿主时为告警桩) */
  ui: ClientUi
  /** 插件命名空间翻译:ctx.t('settings.title') -> plugin.<name>.settings.title */
  t(key: string, params?: ClientTranslateParams): string
  /** 当前界面语言(loader 维护;i18n:changed 钩子在切换时广播;未注入时 '') */
  readonly locale: string
  /** 前缀 console 日志 */
  log: ClientLogger
  /** 卸载:回收订阅 + 清空挂载点 + 广播 client:destroy(幂等) */
  dispose(): void
}

/**
 * 创建客户端插件上下文(客户端 loader 调用)。
 * @param opts.name        插件名(必填)
 * @param opts.eventBridge scene 事件桥:注册回调并返回解绑函数
 * @param opts.baseUrl     ctx.fetch 的前缀(baseUrl + path)
 * @param opts.ui          UI 注入面(缺省告警桩)
 * @param opts.t           翻译函数(缺省回退 plugin.<name>.<key>)
 * @param opts.getLocale   当前语言读取器(缺省回退 '')
 */
export declare function createClientContext(opts?: {
  name: string
  eventBridge?: (fn: (type: string, payload: any) => void) => (() => void)
  baseUrl?: string
  ui?: ClientUi
  t?: (key: string, params?: ClientTranslateParams) => string
  getLocale?: () => string
}): ClientContext

/** 模块私有 el() 助手(default 导出可见;命名导出不含) */
export declare function el(tag: string, attrs?: Record<string, unknown>, children?: Array<Node | string> | Node | string): HTMLElement

declare const _default: {
  CLIENT_SDK_VERSION: string
  createClientContext: typeof createClientContext
  el: typeof el
}
export default _default
