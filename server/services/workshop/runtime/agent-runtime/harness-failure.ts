/**
 * harness 回合失败分类与熔断(2026-10-30 缺陷修复:LLM 预算耗尽任务假活)。
 *
 * 问题:预算耗尽/凭据失效这类"重试不可能成功"的回合失败,此前走既有重投链
 * (每消息 ≤2 次)后任务虽会落 FAILED,但新派发/监督回合继续打死供应商,
 * 任务反复假活,运维只能翻日志发现"预算墙"。
 *
 * 机制(纯函数,无状态;状态由 AgentRuntime 持有):
 *   分类 → 连败串(同类累加/异类重置) → 终态类达阈值即熔断:
 *   当前 WORKING 任务按 HARNESS_UNAVAILABLE_* 收口 + 停止重投;
 *   冷却窗(默认 5min)过后自动半开,允许一次探测回合——成功即复位,再失败立即重新熔断。
 */

export type HarnessFailureClass = 'budget' | 'auth' | 'model' | 'network' | 'other'

/** 人工干预才可能恢复的类别(预算/凭据/模型配置)——重试无意义,触发熔断 */
export const HARNESS_TERMINAL_CLASSES: ReadonlySet<HarnessFailureClass> = new Set(['budget', 'auth', 'model'])

/** 连续同类终态失败达到该次数 → 熔断 */
export const HARNESS_FAIL_STREAK_LIMIT = 3

/** 熔断后半开冷却:距最后一次失败超过该时长,放行探测回合(成功复位/再失败立即重新熔断) */
export const HARNESS_FAIL_COOLDOWN_MS = 5 * 60_000

/** 回合失败分类:code+message 合并小写后按特征归类(network 允许重试,不参与熔断) */
export function classifyHarnessFailure(code: string, message: string): HarnessFailureClass {
  const m = `${code} ${message}`.toLowerCase()
  if (/422|budget/.test(m)) return 'budget'
  if (/401|403|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|api[ _-]?key/.test(m)) return 'auth'
  if (/404|model not found|no such model|not_found/.test(m)) return 'model'
  if (/econn|etimedout|timeout|rpc_broken|spawn|fetch failed|network/.test(m)) return 'network'
  return 'other'
}

export interface HarnessFailStreak {
  cls: HarnessFailureClass
  count: number
  lastAt: number
}

/** 更新连败串:同类累加,异类重置为 1(全新问题重新计数) */
export function recordHarnessFailure(prev: HarnessFailStreak | null, cls: HarnessFailureClass, now = Date.now()): HarnessFailStreak {
  return prev && prev.cls === cls
    ? { cls, count: prev.count + 1, lastAt: now }
    : { cls, count: 1, lastAt: now }
}

/**
 * 熔断是否生效:终态类 + 达阈值 + 处于冷却窗内。
 * 冷却窗外(超过 HARNESS_FAIL_COOLDOWN_MS 未失败)自动半开放行探测,
 * 探测失败会经 recordHarnessFailure 刷新 lastAt 立即重新生效。
 */
export function harnessBreakerActive(streak: HarnessFailStreak | null, now = Date.now()): boolean {
  if (!streak) return false
  if (!HARNESS_TERMINAL_CLASSES.has(streak.cls)) return false
  if (streak.count < HARNESS_FAIL_STREAK_LIMIT) return false
  return now - streak.lastAt < HARNESS_FAIL_COOLDOWN_MS
}
