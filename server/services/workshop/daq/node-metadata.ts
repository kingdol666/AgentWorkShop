/**
 * DAQ 节点元数据校验门(2026-11-15 测评 P1-7)。
 *
 * 模板创建时已校验量程/单位,但节点级 override 走 REST 直调可绕过:
 *  min>=max、warn 带反转、warn 越出量程、decimals 非整数、unit 空白等都会
 * 静默落库,随后越限判定/趋势图/Agent 上下文(单位与语义)全部带病运行。
 *
 * 本模块把「节点元数据自洽性」收敛为单一校验口,create/patch 在落库前调用。
 * 规则刻意保守:只拒绝确定非法的组合,不猜测业务意图(如 warn 带必须落在量程内)。
 */

export interface NodeMetadata {
  name?: string
  unit?: string
  decimals?: number
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  semantics?: string
}

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 返回全部违规原因(空数组 = 通过);调用方按 400 VALIDATION_ERROR 抛出。 */
export function validateNodeMetadata(input: NodeMetadata): string[] {
  const errors: string[] = []
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) errors.push('节点名称不能为空')
    else if (name.length > 120) errors.push('节点名称过长(最多 120 字符)')
    else if (hasControlChars(name)) errors.push('节点名称包含非法控制字符')
  }
  if (input.unit !== undefined) {
    const unit = String(input.unit).trim()
    if (!unit) errors.push('单位不能为空(无单位信号请显式填写如 "1" 或 "-")')
    else if (unit.length > 24) errors.push('单位过长(最多 24 字符)')
    else if (hasControlChars(unit)) errors.push('单位包含非法控制字符')
  }
  if (input.decimals !== undefined) {
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 6) {
      errors.push('小数位需为 0~6 的整数')
    }
  }
  const { min, max } = input
  if (min !== undefined && !isFiniteNumber(min)) errors.push('量程下限 min 必须为有限数字')
  if (max !== undefined && !isFiniteNumber(max)) errors.push('量程上限 max 必须为有限数字')
  if (isFiniteNumber(min) && isFiniteNumber(max) && min >= max) {
    errors.push(`量程非法:需满足 min < max(当前 ${min} >= ${max})`)
  }
  const { warnLow, warnHigh } = input
  if (warnLow !== undefined && warnLow !== null && !isFiniteNumber(warnLow)) errors.push('预警下限 warnLow 必须为有限数字或 null')
  if (warnHigh !== undefined && warnHigh !== null && !isFiniteNumber(warnHigh)) errors.push('预警上限 warnHigh 必须为有限数字或 null')
  if (isFiniteNumber(warnLow) && isFiniteNumber(warnHigh) && warnLow > warnHigh) {
    errors.push(`预警带非法:warnLow(${warnLow}) 不能大于 warnHigh(${warnHigh})`)
  }
  if (isFiniteNumber(min) && isFiniteNumber(warnLow) && warnLow < min) {
    errors.push(`预警下限 warnLow(${warnLow}) 不能低于量程下限 min(${min})`)
  }
  if (isFiniteNumber(max) && isFiniteNumber(warnHigh) && warnHigh > max) {
    errors.push(`预警上限 warnHigh(${warnHigh}) 不能高于量程上限 max(${max})`)
  }
  if (input.semantics !== undefined) {
    if (typeof input.semantics !== 'string') errors.push('采集语义 semantics 必须为字符串')
    else if (input.semantics.length > 500) errors.push('采集语义过长(最多 500 字符)')
    else if (hasControlChars(input.semantics)) errors.push('采集语义包含非法控制字符')
  }
  return errors
}
