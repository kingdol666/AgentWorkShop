/**
 * RecipeRollBackManager 的模块级纯工具/常量(原 server/services/workshop/dcw/recipe-rollback-manager.ts 类外声明,含类体之后与类无关的部分)。
 */
import { dcwSettings } from '../../settings'

export const COOLDOWN_MS = (): number => dcwSettings().rollback_cooldown_ms
/** 系统兜底评估的最小观察窗(env DCW_ROLLBACK_MIN_WINDOW_MS 兼容) */
export const MIN_WINDOW_MS = (): number => dcwSettings().rollback_min_window_ms
/** 兜底评估复查间隔(未触发时) */
export const RECHECK_MS = 30_000
/** 每节点链自动回退上限(超出升级人工) */
export const MAX_AUTO_ROLLBACKS = 2
/** 越限采样数阈值(窗口内) */
export const BREACH_THRESHOLD = 3
/** 锚去重窗口(保写心跳防噪) */
export const ANCHOR_DEDUP_MS = 5_000
/** 基线回看窗(env DCW_ROLLBACK_BASELINE_MS 兼容) */
export const BASELINE_MS = (): number => dcwSettings().rollback_baseline_ms
/** open 记录孤儿判定:属主超时未判定 → 后续 Agent 可接管(env DCW_ROLLBACK_STALE_MS 兼容) */
export const OPEN_RECORD_STALE_MS = (): number => dcwSettings().rollback_stale_ms

/** 数值入参钳制(时间/桶宽:有限正整数,防越界透传) */
export function clampMs(v: number | undefined): number | undefined {
  if (v == null)
    return undefined
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0)
    return undefined
  return Math.min(n, 2_147_483_647)
}
