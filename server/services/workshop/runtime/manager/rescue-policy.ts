/**
 * D1 救援策略（WP9）：busy-stuck 判定。
 *
 * 背景：D1 兜底对「lead 正忙」一律跳过，防误杀健康长回合；但若 lead 卡死在 busy
 * （回合挂死且 abort 未生效），滞留 SUBMITTED 根将永不被救援。这里用会话连续性
 * 的回合起点时间（continuity.lastUsedAt）作为活动信号做纯函数判定：
 *
 *   busy 且 距最后一次回合推进 ≥ minBusyMs → 视为卡死 busy，允许受控重组。
 *
 * 阈值缺省 30min（且不低于 supervise_hard_timeout×2 的下界由调用方保证），
 * 可用 AW_RESCUE_BUSY_STUCK_MS 覆盖（≥60s 生效）。抽成纯函数便于单测。
 */
export function shouldRescueBusyStuck(input: {
  /** lead 运行时当前是否 busy */
  busy: boolean
  /** 连续性视图的 lastUsedAt（ISO；null/缺失=无法判定→保守不救援） */
  lastUsedAt?: string | null
  /** 当前时间戳（ms） */
  now: number
  /** 卡死判定阈值（ms；缺省 30min，最小 60s） */
  minBusyMs?: number
}): boolean {
  if (!input.busy) return false
  const last = input.lastUsedAt ? Date.parse(input.lastUsedAt) : Number.NaN
  if (!Number.isFinite(last)) return false
  const minBusy = Number.isFinite(input.minBusyMs) ? Math.max(60_000, Number(input.minBusyMs)) : 30 * 60_000
  return input.now - last >= minBusy
}
