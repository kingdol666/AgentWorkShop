/**
 * 驱动注册表与旧命名归一解析
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import type { DaqDriverKind } from '../../../../../shared/daq-protocol'
import { DAQ_DRIVERS } from '../../../../../shared/daq-protocol'
import { createPluginDriverRegistry, type PluginDriverMetaLike } from '../../plugin-driver-registry'
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

/**
 * 插件驱动的自描述目录(前端「添加节点」下拉与动态参数表单的数据源)。
 * 插件驱动在 DaqDriver 上携带可选 meta(label/status/configFields,与 DaqDriverMeta 同形、
 * kind 放宽为 string);未带 meta 的插件驱动只在 meta.pluginDrivers 里以 kind 出现,
 * 前端能感知存在但不出表单(如实降级,不猜测参数 schema)。
 * 装配语义(注册/覆盖告警/meta 维护/清空/目录合并)由共享工厂提供。
 */
export type PluginDriverMeta = PluginDriverMetaLike

const plugins = createPluginDriverRegistry<DaqDriver>({
  builtinKinds: REGISTRY,
  driversKey: '__daqPluginDrivers',
  metasKey: '__daqPluginDriverMetas',
  onOverrideBuiltin: kind => log.warn(`[daq-drivers] 插件驱动覆盖内置:「${kind}」`),
})

/** 插件注册的驱动(经 ctx.daq.registerDriver;热重载重复注册幂等覆盖) */
export function pluginRegistry(): Map<string, DaqDriver> {
  return plugins.pluginRegistry()
}

export function pluginMetaRegistry(): Map<string, PluginDriverMeta> {
  return plugins.pluginMetaRegistry()
}

/** 插件驱动注册(kind 与内置冲突时覆盖并告警;resolveDaqDriver 插件优先) */
export function registerPluginDriver(driver: DaqDriver): void {
  plugins.register(driver)
}

export function listPluginDrivers(): string[] {
  return plugins.listKeys()
}

/**
 * 清空插件驱动与自描述目录(插件宿主热重载前调用):停用/卸载的插件驱动随之失效,
 * 只有本轮重新装载成功的插件驱动会再注册进来 —— 否则被停用的驱动会一直生效到进程重启。
 */
export function clearPluginDrivers(): void {
  plugins.clear()
}

/** 插件驱动自描述目录(驱动目录合并端点用;热重载随重注册刷新) */
export function listPluginDriverMetas(): PluginDriverMeta[] {
  return plugins.listMetas()
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
  return plugins.mergedCatalog(DAQ_DRIVERS)
}
