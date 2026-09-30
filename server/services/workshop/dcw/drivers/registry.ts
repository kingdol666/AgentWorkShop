/**
 * 内置驱动注册表 + 插件写驱动注册 + 目录/归一解析
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwDriverKind } from '../../../../../shared/dcw-protocol'
import type { DcwWriteDriver } from './shared'
import { DCW_DRIVERS } from '../../../../../shared/dcw-protocol'
import { createPluginDriverRegistry, type PluginDriverMetaLike } from '../../plugin-driver-registry'
import { httpDcwDriver } from './http'
import { mesRestDcwDriver } from './mes-rest'
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
  'mes-rest': mesRestDcwDriver,
}

/**
 * 插件写驱动注册表(经 ctx.dcw.registerWriteDriver;与数采侧 registerPluginDriver 对称)。
 * resolveDcwDriver 插件优先,热重载同名幂等覆盖;驱动可携带可选 meta(label/configFields)
 * 进写控驱动目录(dcwDriverCatalog)。装配语义(注册/覆盖告警/meta 维护/清空/目录合并)
 * 由共享工厂提供。
 */
export type PluginWriteDriverMeta = PluginDriverMetaLike

const plugins = createPluginDriverRegistry<DcwWriteDriver>({
  builtinKinds: REGISTRY,
  driversKey: '__dcwPluginDrivers',
  metasKey: '__dcwPluginDriverMetas',
  onOverrideBuiltin: kind => console.warn(`[dcw-drivers] 插件写驱动覆盖内置:「${kind}」`),
})

export function pluginRegistry(): Map<string, DcwWriteDriver> {
  return plugins.pluginRegistry()
}

export function pluginMetaRegistry(): Map<string, PluginWriteDriverMeta> {
  return plugins.pluginMetaRegistry()
}

export function registerPluginWriteDriver(driver: DcwWriteDriver): void {
  plugins.register(driver)
}

export function listPluginWriteDrivers(): string[] {
  return plugins.listKeys()
}

/** 插件写驱动自描述目录(写控驱动目录合并端点用) */
export function listPluginWriteDriverMetas(): PluginWriteDriverMeta[] {
  return plugins.listMetas()
}

/** 清空插件写驱动与其自描述目录(插件宿主热重载前调用;与数采侧 clearPluginDrivers 对称) */
export function clearPluginWriteDrivers(): void {
  plugins.clear()
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
  return plugins.mergedCatalog(DCW_DRIVERS)
}

export function normalizeDcwDriverKind(kind: string): DcwDriverKind {
  if (kind === 'modbus') return 'modbus-tcp'
  if (kind === 'rtu' || kind === 'modbus-rtu-tcp') return 'modbus-rtu'
  return ((kind in REGISTRY || pluginRegistry().has(kind) ? kind : 'mock')) as DcwDriverKind
}

export function resolveDcwDriver(kind: DcwDriverKind): DcwWriteDriver {
  return pluginRegistry().get(kind) ?? REGISTRY[kind] ?? mockDcwDriver
}

/** 读能力判定(网关调度周期读前先收敛,不支持读的驱动不空转)。
 *  放在本模块而非 shared.ts:shared 是被驱动反向消费的纯函数层,依赖 registry 会成环。 */
export function supportsDcwRead(kind: DcwDriverKind): boolean {
  return resolveDcwDriver(kind).read != null
}
