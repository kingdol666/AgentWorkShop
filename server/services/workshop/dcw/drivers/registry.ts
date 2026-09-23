/**
 * 内置驱动注册表 + 插件写驱动注册 + 目录/归一解析
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwDriverKind } from '../../../../../shared/dcw-protocol'
import type { DcwWriteDriver } from './shared'
import { DCW_DRIVERS } from '../../../../../shared/dcw-protocol'
import { httpDcwDriver } from './http'
import { mockDcwDriver } from './mock'
import { modbusRtuDcwDriver } from './modbus-rtu'
import { modbusTcpDcwDriver } from './modbus'
import { mqttDcwDriver } from './mqtt'
import { opcUaDcwDriver } from './opcua'

// ============================================================
// 注册表 + 解析
// ============================================================

export const REGISTRY: Record<DcwDriverKind, DcwWriteDriver> = {
  'mock': mockDcwDriver,
  'modbus-tcp': modbusTcpDcwDriver,
  'modbus-rtu': modbusRtuDcwDriver,
  'opcua': opcUaDcwDriver,
  'mqtt': mqttDcwDriver,
  'http': httpDcwDriver,
}

/**
 * 插件写驱动注册表(经 ctx.dcw.registerWriteDriver;与数采侧 registerPluginDriver 对称)。
 * globalThis 防 HMR 双实例;resolveDcwDriver 插件优先,热重载同名幂等覆盖。
 * 驱动可携带可选 meta(label/configFields)进写控驱动目录(dcwDriverCatalog)。
 */
export interface PluginWriteDriverMeta {
  kind: string
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields?: import('../../../../../shared/daq-protocol').DriverConfigField[]
  plugin: true
}

export const g_plugins = globalThis as typeof globalThis & { __dcwPluginDrivers?: Map<string, DcwWriteDriver> }
export function pluginRegistry(): Map<string, DcwWriteDriver> {
  return g_plugins.__dcwPluginDrivers ??= new Map()
}

export const g_metas = globalThis as typeof globalThis & { __dcwPluginDriverMetas?: Map<string, PluginWriteDriverMeta> }
export function pluginMetaRegistry(): Map<string, PluginWriteDriverMeta> {
  return g_metas.__dcwPluginDriverMetas ??= new Map()
}

export function registerPluginWriteDriver(driver: DcwWriteDriver): void {
  if (driver.kind in REGISTRY) console.warn(`[dcw-drivers] 插件写驱动覆盖内置:「${driver.kind}」`)
  pluginRegistry().set(driver.kind, driver)
  const meta = (driver as DcwWriteDriver & { meta?: Omit<PluginWriteDriverMeta, 'kind' | 'plugin'> }).meta
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
    pluginMetaRegistry().delete(driver.kind)
  }
}

export function listPluginWriteDrivers(): string[] {
  return [...pluginRegistry().keys()]
}

/** 插件写驱动自描述目录(写控驱动目录合并端点用) */
export function listPluginWriteDriverMetas(): PluginWriteDriverMeta[] {
  return [...pluginMetaRegistry().values()]
}

/** 清空插件写驱动与其自描述目录(插件宿主热重载前调用;与数采侧 clearPluginDrivers 对称) */
export function clearPluginWriteDrivers(): void {
  pluginRegistry().clear()
  pluginMetaRegistry().clear()
}

/**
 * 写控驱动目录(内置 DCW_DRIVERS + 插件自描述合并;同名插件条目覆盖内置)。
 * dcw index.get 以 `drivers` 下发,前端写控节点向导据此渲染。
 */
export async function dcwDriverCatalog(): Promise<Array<{
  kind: string
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields: import('../../../../../shared/daq-protocol').DriverConfigField[]
  plugin?: boolean
}>> {
  const out: Array<{ kind: string, label: string, status: 'builtin' | 'real' | 'planned', configFields: import('../../../../../shared/daq-protocol').DriverConfigField[], plugin?: boolean }> = DCW_DRIVERS.map(d => ({
    kind: d.kind,
    label: d.label,
    status: d.status,
    configFields: d.configFields,
  }))
  for (const m of listPluginWriteDriverMetas()) {
    const i = out.findIndex(d => d.kind === m.kind)
    const entry = { kind: m.kind, label: m.label, status: m.status, configFields: m.configFields ?? [], plugin: true }
    if (i >= 0) out[i] = entry
    else out.push(entry)
  }
  return out
}

export function normalizeDcwDriverKind(kind: string): DcwDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
  if (kind === 'rtu' || kind === 'modbus-rtu-tcp') return 'modbus-rtu'
  return ((kind in REGISTRY || pluginRegistry().has(kind) ? kind : 'mock')) as DcwDriverKind
}

export function resolveDcwDriver(kind: DcwDriverKind): DcwWriteDriver {
  return pluginRegistry().get(kind) ?? REGISTRY[kind] ?? mockDcwDriver
}
