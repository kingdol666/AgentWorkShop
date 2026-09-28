/**
 * 插件驱动注册表工厂 —— 数采(daq)与写控(dcw)两侧共用的插件驱动装配语义:
 * 注册(同名覆盖内置时告警)/ meta 自描述目录维护(重注册不带 meta 时一并清除)/
 * 清空(插件宿主热重载前调用)/ 目录合并(内置 + 插件,同名插件条目覆盖内置)。
 *
 * globalThis 键由调用方指定(防 HMR 双实例,两侧沿用既有键名);
 * 插件驱动在 driver 上携带可选 meta(label/status/configFields)进自描述目录。
 */
import type { DriverConfigField } from '../../../shared/daq-protocol'

export interface PluginDriverMetaLike {
  kind: string
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields?: DriverConfigField[]
  /** true = 来自插件协议插件(前端展示「插件」徽标) */
  plugin: true
}

export interface BuiltinCatalogEntry {
  kind: string
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields: DriverConfigField[]
}

/** 插件驱动最小结构(kind + 可选自描述 meta) */
interface DriverWithOptionalMeta {
  kind: string
  meta?: { label?: unknown, status?: unknown, configFields?: unknown }
}

export function createPluginDriverRegistry<T extends DriverWithOptionalMeta>(opts: {
  /** 内置 kind 集合(对象映射或 Set;插件同名注册时触发覆盖告警) */
  builtinKinds: Readonly<Record<string, unknown>> | ReadonlySet<string>
  /** globalThis 字段名(驱动表) */
  driversKey: string
  /** globalThis 字段名(meta 目录表) */
  metasKey: string
  /** 覆盖内置时的告警回调(入参 = kind;文案由调用方定,daq/dcw 措辞各异) */
  onOverrideBuiltin: (kind: string) => void
}) {
  const g = globalThis as typeof globalThis & Record<string, unknown>
  const isBuiltin = (kind: string): boolean =>
    opts.builtinKinds instanceof Set ? opts.builtinKinds.has(kind) : kind in opts.builtinKinds

  function pluginRegistry(): Map<string, T> {
    if (!(g[opts.driversKey] instanceof Map)) g[opts.driversKey] = new Map<string, T>()
    return g[opts.driversKey] as Map<string, T>
  }

  function pluginMetaRegistry(): Map<string, PluginDriverMetaLike> {
    if (!(g[opts.metasKey] instanceof Map)) g[opts.metasKey] = new Map<string, PluginDriverMetaLike>()
    return g[opts.metasKey] as Map<string, PluginDriverMetaLike>
  }

  function register(driver: T): void {
    if (isBuiltin(driver.kind)) opts.onOverrideBuiltin(driver.kind)
    pluginRegistry().set(driver.kind, driver)
    const meta = (driver as DriverWithOptionalMeta).meta
    if (meta && typeof meta.label === 'string') {
      pluginMetaRegistry().set(driver.kind, {
        kind: driver.kind,
        label: meta.label,
        status: meta.status === 'builtin' || meta.status === 'planned' ? meta.status : 'real',
        configFields: Array.isArray(meta.configFields) ? meta.configFields as DriverConfigField[] : [],
        plugin: true,
      })
    }
    else {
      // 同名驱动重注册(热重载)可能这次不带 meta:旧 meta 一并清除,保持两边一致
      pluginMetaRegistry().delete(driver.kind)
    }
  }

  function listKeys(): string[] {
    return [...pluginRegistry().keys()]
  }

  function listMetas(): PluginDriverMetaLike[] {
    return [...pluginMetaRegistry().values()]
  }

  /** 清空插件驱动与自描述目录(插件宿主热重载前调用;停用/卸载的插件驱动随之失效) */
  function clear(): void {
    pluginRegistry().clear()
    pluginMetaRegistry().clear()
  }

  /** 目录合并(内置目录 + 插件自描述;同名插件条目覆盖内置并标记 plugin) */
  function mergedCatalog(builtin: ReadonlyArray<BuiltinCatalogEntry>): Array<BuiltinCatalogEntry & { plugin?: boolean }> {
    const out: Array<BuiltinCatalogEntry & { plugin?: boolean }> = builtin.map(d => ({
      kind: d.kind,
      label: d.label,
      status: d.status,
      configFields: d.configFields,
    }))
    for (const m of listMetas()) {
      const i = out.findIndex(d => d.kind === m.kind)
      const entry = { kind: m.kind, label: m.label, status: m.status, configFields: m.configFields ?? [], plugin: true }
      if (i >= 0) out[i] = entry
      else out.push(entry)
    }
    return out
  }

  return { pluginRegistry, pluginMetaRegistry, register, listKeys, listMetas, clear, mergedCatalog }
}
