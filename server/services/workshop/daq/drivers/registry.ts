/**
 * 驱动注册表与旧命名归一解析
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import type { DaqDriverKind } from '../../../../../shared/daq-protocol'
import { DAQ_DRIVERS } from '../../../../../shared/daq-protocol'
import { PlannedProtocolStub } from './s7-stub'
import { httpDaqDriver } from './http'
import { log } from './shared'
import { mockDaqDriver } from './mock'
import { modbusRtuDriver } from './modbus-rtu'
import { modbusTcpDriver } from './modbus-tcp'
import { mqttDaqDriver } from './mqtt'
import { opcUaDriver } from './opcua'

// ============================================================
// 注册表 + 解析(旧命名归一)
// ============================================================

export const REGISTRY: Record<DaqDriverKind, DaqDriver> = {
  'mock': mockDaqDriver,
  'modbus-tcp': modbusTcpDriver,
  'modbus-rtu': modbusRtuDriver,
  'opcua': opcUaDriver,
  'mqtt': mqttDaqDriver,
  'http': httpDaqDriver,
  's7': new PlannedProtocolStub('s7', 'S7comm'),
}

/** 插件注册的驱动(经 ctx.daq.registerDriver;热重载重复注册幂等覆盖) */
export const g_plugins = globalThis as typeof globalThis & { __daqPluginDrivers?: Map<string, DaqDriver> }
export function pluginRegistry(): Map<string, DaqDriver> {
  return g_plugins.__daqPluginDrivers ??= new Map()
}

/**
 * 插件驱动的自描述目录(前端「添加节点」下拉与动态参数表单的数据源)。
 * 插件驱动在 DaqDriver 上携带可选 meta(label/status/configFields,与 DaqDriverMeta 同形、
 * kind 放宽为 string);未带 meta 的插件驱动只在 meta.pluginDrivers 里以 kind 出现,
 * 前端能感知存在但不出表单(如实降级,不猜测参数 schema)。
 */
export interface PluginDriverMeta {
  kind: string
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields?: import('../../../../../shared/daq-protocol').DriverConfigField[]
  /** true = 来自插件协议插件(前端展示「插件」徽标) */
  plugin: true
}

export const g_metas = globalThis as typeof globalThis & { __daqPluginDriverMetas?: Map<string, PluginDriverMeta> }
export function pluginMetaRegistry(): Map<string, PluginDriverMeta> {
  return g_metas.__daqPluginDriverMetas ??= new Map()
}

/** 插件驱动注册(kind 与内置冲突时覆盖并告警;resolveDaqDriver 插件优先) */
export function registerPluginDriver(driver: DaqDriver): void {
  if (driver.kind in REGISTRY) log.warn(`[daq-drivers] 插件驱动覆盖内置:「${driver.kind}」`)
  pluginRegistry().set(driver.kind, driver)
  const meta = (driver as DaqDriver & { meta?: Omit<PluginDriverMeta, 'kind' | 'plugin'> }).meta
  if (meta && typeof meta.label === 'string') {
    pluginMetaRegistry().set(driver.kind, {
      kind: driver.kind,
      label: meta.label,
      status: meta.status === 'builtin' || meta.status === 'planned' ? meta.status : 'real',
      configFields: Array.isArray(meta.configFields) ? meta.configFields : [],
      plugin: true,
    })
  }
  else {
    // 同名驱动重注册(热重载)可能这次不带 meta:旧 meta 一并清除,保持两边一致
    pluginMetaRegistry().delete(driver.kind)
  }
}

export function listPluginDrivers(): string[] {
  return [...pluginRegistry().keys()]
}

/**
 * 清空插件驱动与自描述目录(插件宿主热重载前调用):停用/卸载的插件驱动随之失效,
 * 只有本轮重新装载成功的插件驱动会再注册进来 —— 否则被停用的驱动会一直生效到进程重启。
 */
export function clearPluginDrivers(): void {
  pluginRegistry().clear()
  pluginMetaRegistry().clear()
}

/** 插件驱动自描述目录(驱动目录合并端点用;热重载随重注册刷新) */
export function listPluginDriverMetas(): PluginDriverMeta[] {
  return [...pluginMetaRegistry().values()]
}

export function normalizeDriverKind(kind: string): DaqDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
  if (kind === 'rtu' || kind === 'modbus-rtu-tcp') return 'modbus-rtu'
  return (kind in REGISTRY || pluginRegistry().has(kind) ? kind : 'mock') as DaqDriverKind
}

export function resolveDaqDriver(kind: DaqDriverKind): DaqDriver {
  return pluginRegistry().get(kind) ?? REGISTRY[kind] ?? mockDaqDriver
}

/** 驱动可用性探测(meta 报告:包缺失时 UI 显示"未安装"而非硬失败;含插件驱动) */
export async function probeDriverAvailability(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  const all: Array<[string, DaqDriver]> = [...Object.entries(REGISTRY), ...pluginRegistry()]
  for (const [kind, drv] of all) {
    try {
      out[kind] = await drv.available()
    }
    catch {
      out[kind] = false
    }
  }
  return out
}

/**
 * 驱动目录合并(内置 DAQ_DRIVERS + 插件自描述;同名插件条目覆盖内置并标记 plugin)。
 * index.get.ts 以 `drivers` 下发,前端据此渲染「添加节点」下拉与动态参数表单。
 */
export async function driverCatalog(): Promise<Array<{
  kind: string
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields: import('../../../../../shared/daq-protocol').DriverConfigField[]
  plugin?: boolean
}>> {
  const out: Array<{ kind: string, label: string, status: 'builtin' | 'real' | 'planned', configFields: import('../../../../../shared/daq-protocol').DriverConfigField[], plugin?: boolean }> = DAQ_DRIVERS.map(d => ({
    kind: d.kind,
    label: d.label,
    status: d.status,
    configFields: d.configFields,
  }))
  for (const m of listPluginDriverMetas()) {
    const i = out.findIndex(d => d.kind === m.kind)
    const entry = { kind: m.kind, label: m.label, status: m.status, configFields: m.configFields ?? [], plugin: true }
    if (i >= 0) out[i] = entry
    else out.push(entry)
  }
  return out
}
