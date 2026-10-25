/**
 * 数采推送(ingest)鉴权与回填窗策略 —— 纯函数单点(WP2)。
 *
 * 背景:ingest 历史行为是「配置了 AW_DAQ_INGEST_TOKEN 就校验头,否则退回仪表盘会话」,
 * 兜底路径**不查产线权限**且 `at` 允许 ±7 天回填 —— 任意注册用户可向任意启用节点
 * 注入(含回填)伪造样本,污染 AML 训练链。此处把判定收敛为可单测的纯函数:
 *  - 兜底路径必须过 requireLineMode(operate):无产线操控权 → 403;
 *  - 回填窗默认 ±1h(env AW_DAQ_INGEST_BACKFILL_MS 可调,上限仍 7 天);
 *  - 配置超宽(>1h)时启动期告警(安全开关回归可见性)。
 *
 * token 路径(AW_DAQ_INGEST_TOKEN)语义不变:全局推送凭据,用于边缘系统无会话接入。
 */

export const DEFAULT_BACKFILL_MS = 3600_000
export const MAX_BACKFILL_MS = 7 * 24 * 3600_000
export const WIDE_WINDOW_THRESHOLD_MS = 3600_000

/** 回填窗(ms):缺省 1h;env 可调,钳制到 [0, 7d] */
export function ingestBackfillWindowMs(env: Record<string, string | undefined> = process.env): number {
  const rawEnv = env.AW_DAQ_INGEST_BACKFILL_MS
  if (rawEnv === undefined || String(rawEnv).trim() === '') return DEFAULT_BACKFILL_MS
  const raw = Number(rawEnv)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_BACKFILL_MS
  return Math.min(raw, MAX_BACKFILL_MS)
}

/** 是否处于「超宽回填窗」配置(安全开关打开态;启动/首请求告警) */
export function isWideBackfillWindow(env: Record<string, string | undefined> = process.env): boolean {
  return ingestBackfillWindowMs(env) > WIDE_WINDOW_THRESHOLD_MS
}

/** 时间点是否在允许窗内 */
export function withinBackfillWindow(atMs: number, now: number, windowMs: number): boolean {
  return Number.isFinite(atMs) && Math.abs(atMs - now) <= windowMs
}

/** 推送鉴权模式判定(纯函数便于单测):token 已配置 → 校验头;未配置 → 会话+产线权限 */
export function ingestAuthMode(input: { configuredToken?: string, providedToken?: string }): 'token' | 'token-mismatch' | 'session' {
  if (input.configuredToken) {
    return input.providedToken === input.configuredToken ? 'token' : 'token-mismatch'
  }
  return 'session'
}
