/**
 * ParamConversion —— 工艺参数 → PLC 标准转换模式展开器(配置期)。
 *
 * 用户在映射配置期选定「标准转换模式」(float32 直写 / int16·int32 线性标定)
 * 与设备连接 + 寄存器,本模块将其一次性展开为执行节点驱动配置:
 *   - float32       原始值 = 工程值,驱动直写 float32
 *   - int16-scaled  eng∈[engMin,engMax] 线性映射 raw∈[rawMin,rawMax],int16 编码
 *   - int32-scaled  同上,int32 编码
 * 运行期双向换算(下发 encode / 回读 decode)由既有驱动链完成,本模块零参与 ——
 * 展开产物即单一事实源(driverConfig),转换模式本身仅作展示/审计摘要留存。
 */

import type { ParamAccessSpec } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'

/** 展开产物:执行节点创建所需的驱动字段(结构与 DCW 驱动 configFields 一致) */
export interface DerivedAccess {
  driver: 'modbus-tcp' | 'modbus-rtu'
  driverConfig: Record<string, string | number | boolean>
  /** 节点工艺安全量程(取标定工程量程;float32 模式由调用方回退模板量程) */
  engMin?: number
  engMax?: number
}

/** 校验 + 展开:接入规格 → 驱动配置(非法配置在配置期即拒,不带病运行) */
export function deriveAccess(access: ParamAccessSpec): DerivedAccess {
  const driver = access.driver ?? 'modbus-tcp'
  const host = String(access.host ?? '').trim()
  if (!host) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'access.host 必填:设备连接地址(PLC/网关 IP)')
  const register = Number(access.register)
  if (!Number.isInteger(register) || register < 40001 || register > 49999) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `access.register 须为 4xxxx 保持寄存器地址(当前: ${String(access.register)})`)
  }
  const conv = access.conversion
  if (!conv || !['float32', 'int16-scaled', 'int32-scaled'].includes(conv?.mode)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `access.conversion.mode 须为标准转换模式之一: float32 / int16-scaled / int32-scaled(当前: ${String(conv?.mode)})`)
  }
  const byteOrder = conv.byteOrder ?? 'big'
  const base = {
    host,
    port: access.port == null ? 502 : Number(access.port),
    unitId: access.unitId == null ? 1 : Number(access.unitId),
    register,
  }

  if (conv.mode === 'float32') {
    // float32 直写:未配原始量程 → 驱动 raw=eng
    return {
      driver,
      driverConfig: { ...base, dataType: 'float32', byteOrder },
    }
  }

  // int16/int32 线性标定:标定量程必填且 eng 跨度/raw 跨度非零
  const engMin = Number(conv.engMin)
  const engMax = Number(conv.engMax)
  const rawMin = Number(conv.rawMin)
  const rawMax = Number(conv.rawMax)
  for (const [k, v] of [['engMin', engMin], ['engMax', engMax], ['rawMin', rawMin], ['rawMax', rawMax]] as const) {
    if (!Number.isFinite(v)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `转换模式 ${conv.mode} 需要完整线性标定:${k} 缺失或非数字`)
  }
  if (engMax === engMin) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `线性标定非法:engMax(${engMax}) 不得等于 engMin`)
  if (rawMax === rawMin) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `线性标定非法:rawMax(${rawMax}) 不得等于 rawMin`)
  return {
    driver,
    driverConfig: {
      ...base,
      dataType: conv.mode === 'int16-scaled' ? 'int16' : 'int32',
      byteOrder,
      engMin,
      engMax,
      rawMin,
      rawMax,
    },
    engMin,
    engMax,
  }
}
