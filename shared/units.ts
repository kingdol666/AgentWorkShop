/**
 * 工程↔模型单位唯一换算边界(D23)。
 *
 * `variable.unit` = 工程单位(DCW/配方/操作员面),`modelUnit` = 模型单位(模型训练/IR/求解全程)。
 * 换算:model = value*scale + offset;engineering = (model − offset)/scale。
 *
 * 铁律:scale/offset 缺失、为 0 或非有限一律抛 422 —— **禁止按 1/0 兜底**
 * (train/serve skew:训练按兜底换算、推理按另一口径,结论不可信)。
 * aml 与 optimization 共用本模块(避免反向依赖)。
 */
export interface UnitTransform {
  scale: number
  offset: number
}

export class UnitContractError extends Error {
  readonly status = 422
  readonly code = 'UNIT_CONTRACT_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'UnitContractError'
  }
}

function assertTransform(t: UnitTransform, what: string): void {
  const scale = Number(t?.scale)
  const offset = Number(t?.offset)
  if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) {
    throw new UnitContractError(
      `${what} 的单位换算非法(scale=${String(t?.scale)},offset=${String(t?.offset)}):scale 必须为非零有限数,offset 必须为有限数;禁止按 1/0 兜底`,
    )
  }
}

/** 工程值 → 模型值:model = value*scale + offset */
export function toModel(value: number, t: UnitTransform, what = '变量'): number {
  assertTransform(t, what)
  return value * t.scale + t.offset
}

/** 模型值 → 工程值:engineering = (model − offset)/scale */
export function toEngineering(model: number, t: UnitTransform, what = '变量'): number {
  assertTransform(t, what)
  return (model - t.offset) / t.scale
}

/** 宽松读取(仅供展示/回显;业务换算必须走 toModel/toEngineering) */
export function readTransform(raw: { scale?: unknown, offset?: unknown } | undefined): UnitTransform {
  return { scale: Number(raw?.scale), offset: Number(raw?.offset) }
}
