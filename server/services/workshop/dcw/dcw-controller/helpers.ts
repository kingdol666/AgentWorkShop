/**
 * DcwController 的模块级纯工具/常量(原 server/services/workshop/dcw/dcw-controller.ts 类外声明,含类体之后与类无关的部分)。
 */
import type { ProductInput } from '../../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../../utils/errors'
import { attachDcwPluginBridge } from '../plugin-bridge'
import { getDcwParamRepo } from '../param-map.repo'

export const opsWriteMemo = new Map<string, { eng: number, at: number }>()

// 写驱动插件桥(模块装载即挂;插件宿主先到则注册项排队、此处接管回放)
attachDcwPluginBridge()

/** 周期读网关默认间隔(节点 readIntervalMs=null 时生效;真实 PLC 建议按链路承载调整) */
export const DEFAULT_READ_INTERVAL_MS = 5000

/** write() 来源 → 日志来源(user 人工下发 / agent 智能体 / system 配方·回退等系统路径) */
export function opsActorKindOf(source: string): 'user' | 'agent' | 'system' {
  if (source === 'agent') return 'agent'
  if (source === 'manual') return 'user'
  return 'system'
}

export const SWEEP_MS = 500

/**
 * 产品级工艺参数限界校验:键必须命中该产品所属产线上的工艺参数映射
 * (防静默失效的拼错键);区间须 min<=max 且为有限数字。产品未挂产线时限界无
 * 寻址语境,拒绝非空限界。
 */
export function assertProductParamLimits(lineId: string, paramLimits: ProductInput['paramLimits'] | undefined): void {
  if (paramLimits == null) return
  if (typeof paramLimits !== 'object' || Array.isArray(paramLimits)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'paramLimits 需为对象(键=工艺参数 key,值={min?,max?})')
  }
  const entries = Object.entries(paramLimits)
  if (entries.length === 0) return
  if (!lineId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '产品未挂载产线,不可设定工艺参数限界(限界按产线内的工艺参数寻址)')
  }
  const lineKeys = new Set(
    getDcwParamRepo().listViews().filter(p => p.lineId === lineId).map(p => p.key),
  )
  for (const [key, range] of entries) {
    if (!lineKeys.has(key)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产品限界的工艺参数键「${key}」在产线上不存在(可用的工艺参数:${[...lineKeys].join(', ') || '无 —— 先创建写控节点生成参数面'})`)
    }
    const min = range?.min == null ? null : Number(range.min)
    const max = range?.max == null ? null : Number(range.max)
    if ((range?.min != null && !Number.isFinite(min)) || (range?.max != null && !Number.isFinite(max))) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产品限界「${key}」的上下限需为数字`)
    }
    if (min != null && max != null && min > max) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `产品限界「${key}」非法:min ${min} > max ${max}`)
    }
  }
}
