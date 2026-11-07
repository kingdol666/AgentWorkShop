/**
 * Project 派发容量解析（WP4）。
 *
 * 此前 `doAutoDispatch` 内硬编码 `{ perChannel: 1, perProject: 4, perTick: 2 }`，
 * 是单项目并行吞吐的硬天花板。现从运行语义设置解析（workshop.dispatch_per_project /
 * workshop.dispatch_per_tick），缺省值保持 4/2（默认行为不变），并做钳制：
 *
 *   perChannel 恒为 1 —— 每任务实例 Channel 单根是引擎级硬约束（根 FIFO 按 Channel），
 *   绝不随配置放宽。perProject ∈ [1,16]、perTick ∈ [1,8]（上限防运行时进程膨胀）。
 *
 * 抽成纯函数便于单测与 observability 透出（effective limits 对前端/运维可见）。
 */
export interface DispatchLimits {
  perChannel: 1
  perProject: number
  perTick: number
}

export const DISPATCH_LIMITS_BOUNDS = {
  perProject: { min: 1, max: 16, default: 4 },
  perTick: { min: 1, max: 8, default: 2 },
} as const

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 从运行语义设置解析有效派发容量（缺省 4/2，钳制到 1..16 / 1..8）。 */
export function resolveDispatchLimits(input: { dispatch_per_project?: unknown, dispatch_per_tick?: unknown } | null | undefined): DispatchLimits {
  return {
    perChannel: 1,
    perProject: clampInt(input?.dispatch_per_project, DISPATCH_LIMITS_BOUNDS.perProject.default, DISPATCH_LIMITS_BOUNDS.perProject.min, DISPATCH_LIMITS_BOUNDS.perProject.max),
    perTick: clampInt(input?.dispatch_per_tick, DISPATCH_LIMITS_BOUNDS.perTick.default, DISPATCH_LIMITS_BOUNDS.perTick.min, DISPATCH_LIMITS_BOUNDS.perTick.max),
  }
}
