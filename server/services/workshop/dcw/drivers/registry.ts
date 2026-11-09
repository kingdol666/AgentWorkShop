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

function aliasDcwDriverKind(kind: string): string {
  if (kind === 'modbus') return 'modbus-tcp'
  if (kind === 'rtu' || kind === 'modbus-rtu-tcp') return 'modbus-rtu'
  return kind
}

/**
 * 严格解析(入口级:create/patch/testDriver):未知 kind 显式报错。
 * 配置错协议名静默采 mock 驱动 = 写路径假成功(工业高危默认,2026-10-08 P0-5;
 * 与 daq 侧 requireDriverKind 2026-10-04 评审同口径)。
 */
export function requireDcwDriverKind(kind: string): DcwDriverKind {
  const k = aliasDcwDriverKind(kind)
  if (k in REGISTRY || pluginRegistry().has(k)) return k as DcwDriverKind
  throw new Error('未知写控驱动协议: ' + JSON.stringify(kind) + '(已注册: ' + [...Object.keys(REGISTRY), ...pluginRegistry().keys()].join(', ') + ')')
}

/**
 * 启动迁移:磁盘遗留 kind 别名归一。
 *
 * 未知 kind **不再降级 mock**(2026-11-10 对齐 DAQ S11):mock 驱动写返回 ok:true、
 * 回读读同一进程内 Map,会把"驱动插件没加载/协议名写错"变成一次"写成功且设备证实"
 * 的假闭环。现在保留原名并标 unknown,由 resolveDcwDriver 落到 unavailableDcwDriver
 * 显式失败,等插件注册或人工重配(不砖启动)。
 */
export function migrateDcwDriverKind(kind: string): { kind: DcwDriverKind, downgraded: boolean, unknown?: boolean } {
  const k = aliasDcwDriverKind(kind)
  if (k in REGISTRY || pluginRegistry().has(k)) return { kind: k as DcwDriverKind, downgraded: false }
  return { kind: k as DcwDriverKind, downgraded: false, unknown: true }
}

/**
 * 驱动缺失占位(插件未加载/已卸载、磁盘遗留坏 kind 经 resolve 直达):
 * 写/读/测试一律显式失败 —— 曾经的 `?? mockDcwDriver` 兜底会让真实协议节点
 * 在驱动缺失时静默按 mock 成功(假成功,2026-10-07 事故链一环)。
 */
function unavailableDcwDriver(kind: string): DcwWriteDriver {
  const msg = `写控驱动「${kind}」未注册(插件未加载或已卸载),已拒绝执行 —— 请重新配置节点驱动`
  return {
    kind: kind as DcwDriverKind,
    available: async () => false,
    write: async () => ({ ok: false, message: msg, raw: null, readback: null }),
    test: async () => ({ ok: false, message: msg }),
    read: async () => ({ ok: false, message: msg, eng: null, raw: null }),
  }
}

export function resolveDcwDriver(kind: DcwDriverKind): DcwWriteDriver {
  return pluginRegistry().get(kind) ?? REGISTRY[kind] ?? unavailableDcwDriver(kind)
}

/** 读能力判定(网关调度周期读前先收敛,不支持读的驱动不空转)。
 *  放在本模块而非 shared.ts:shared 是被驱动反向消费的纯函数层,依赖 registry 会成环。 */
export function supportsDcwRead(kind: DcwDriverKind): boolean {
  return resolveDcwDriver(kind).read != null
}
