/**
 * SystemConfigService 的依赖类型与对外 DTO(原 server/services/system-config.ts 顶部模块级类型声明)。纯类型。
 */
import type { SettingsDescriptor } from '@/shared/config/engine.mjs'

export interface ConfigGroup {
  id: string
  label: string
  labelKey?: string
  description: string
  /** 排序权重(小在前);内置分组按 schema 声明顺序 ×10。
   *  可缺省:持久化条目与插件声明允许不写 order,由 shared/config/groups.mjs 的
   *  mergeGroups 沿用内置声明顺序兜底(消费侧见 nextGroupOrder/updateGroup 均按可缺省处理)。 */
  order?: number
  /** 前端默认折叠态(用户本地展开偏好优先) */
  collapsed: boolean
  collapsible: boolean
  icon: string
  source: 'builtin' | 'user' | 'plugin'
  /** source=plugin 时的插件名 */
  plugin?: string
  /** 该分组下的字段数(只读,由服务端按当前描述符实时计算) */
  fieldCount?: number
}

/* ---------- 描述符 key → runtimeConfig 字段映射 ----------
 * nuxt.config runtimeConfig 的结构：
 *   public.appTitle/appTitle/description/mode/apiBase/apiTimeout/primaryColor/themeMode/...
 *   apiPageSize / apiMaxPageSize / approvalGate / daq.{...}
 */
export interface PublicSnapshot {
  descriptors: SettingsDescriptor[]
  /** 有序分组(后端权威;前端据此渲染分区、顺序、折叠态) */
  groups: ConfigGroup[]
  effective: Record<string, unknown>
  overrides: Record<string, unknown>
  sources: Record<string, 'config.yml' | 'runtime' | 'env'>
  settingsPath: string
  configPath: string
}

/** 广播载荷 */
export interface ConfigEventPayload {
  type: 'config:changed' | 'config:reset' | 'config:reloaded'
  changed: string[]
  restartRequired: string[]
  effective: Record<string, unknown>
  sources: Record<string, unknown>
  overrides: Record<string, unknown>
  at: string
}

export type Listener = (payload: ConfigEventPayload) => void

/** runtimeConfig 的动态视图:PUBLIC_FIELDS(public.*)/ROOT_FIELDS(根字段)/daq.* 三处动态读写共用 */
export type RuntimeConfigView = Record<string, unknown> & { public: Record<string, unknown> }

/** 从 catch 的 unknown 值取可读错误文本(与原先的 String(err?.message ?? err) 运行时完全等价) */
