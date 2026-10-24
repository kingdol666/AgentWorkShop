/**
 * 运行时守卫求值器(纯函数)。
 *
 * 守卫是本体检出「状态条件」类规则后的**可执行**形态:
 *   当 when 成立(或状态未知且打算提速)时,禁止对目标变量的增量动作。
 *
 * fail-closed 语义(计划 §5.2):设备状态未知时不得默认认为可以提速 ——
 * 若 when 的观测变量缺失且调用方打算做正向增量,判为违规(仅在 onViolate=
 * 'block_recommendation' 时阻断)。
 */
import type { ControlGuard } from './contracts'

export type GuardValue = number | string | boolean

export interface GuardEvaluationInput {
  /** 当前观测/状态快照(变量 key → 值) */
  values: Record<string, GuardValue>
  /** 本次候选动作的增量(变量 key → 增量;缺省视为无动作) */
  deltas?: Record<string, number>
  /** 作用域(与守卫 scope 比对;任一侧缺省则不约束该维) */
  scope?: { lineId?: string, recipeId?: string, conditionId?: string }
}

export interface GuardViolation {
  guardId: string
  ruleId: string
  variableKey: string
  onViolate: 'block_recommendation' | 'annotate'
  message: string
  reason: 'condition_met' | 'state_unknown'
}

export interface GuardEvaluationResult {
  ok: boolean
  /** 是否存在 block_recommendation 级违规 */
  blocked: boolean
  violations: GuardViolation[]
  evaluated: number
  skipped: number
}

function scopeMatches(guard: ControlGuard, scope: GuardEvaluationInput['scope']): boolean {
  if (!scope) return true
  const pairs: Array<[string, string | undefined]> = [
    [guard.scope.lineId, scope.lineId],
    [guard.scope.recipeId, scope.recipeId],
    [guard.scope.conditionId, scope.conditionId],
  ]
  for (const [guardValue, inputValue] of pairs) {
    if (guardValue && inputValue && guardValue !== inputValue) return false
  }
  return true
}

function compare(actual: GuardValue, op: ControlGuard['when']['op'], expected: GuardValue): boolean | null {
  if (op === 'eq') return actual === expected
  if (op === 'neq') return actual !== expected
  if (typeof actual !== 'number' || typeof expected !== 'number') return null
  switch (op) {
    case 'lt': return actual < expected
    case 'lte': return actual <= expected
    case 'gt': return actual > expected
    case 'gte': return actual >= expected
    default: return null
  }
}

function deltaOf(input: GuardEvaluationInput, variableKey: string): number {
  const delta = input.deltas?.[variableKey]
  return typeof delta === 'number' && Number.isFinite(delta) ? delta : 0
}

function isForbiddenDelta(kind: ControlGuard['forbid']['kind'], delta: number): boolean {
  return kind === 'positive_increment' ? delta > 0 : delta !== 0
}

/** 求值一组守卫(纯函数;无 IO、无时钟依赖) */
export function evaluateGuards(guards: ControlGuard[], input: GuardEvaluationInput): GuardEvaluationResult {
  const violations: GuardViolation[] = []
  let evaluated = 0
  let skipped = 0

  for (const guard of guards) {
    if (!scopeMatches(guard, input.scope)) {
      skipped += 1
      continue
    }
    const forbidKey = guard.forbid.variableKey
    const delta = deltaOf(input, forbidKey)
    const observed = input.values[guard.when.variableKey]

    if (observed === undefined) {
      // 状态未知:只有打算做被禁动作时才按 fail-closed 判违规(否则这条守卫无从触发)
      if (isForbiddenDelta(guard.forbid.kind, delta)) {
        violations.push({
          guardId: guard.id, ruleId: guard.ruleId, variableKey: forbidKey, onViolate: guard.onViolate,
          reason: 'state_unknown',
          message: `${guard.message}(状态变量「${guard.when.variableKey}」未知,拒绝本次增量)`,
        })
        evaluated += 1
      }
      else { skipped += 1 }
      continue
    }

    const met = compare(observed, guard.when.op, guard.when.value)
    if (met === null) {
      skipped += 1
      continue
    }
    evaluated += 1
    if (!met) continue
    if (!isForbiddenDelta(guard.forbid.kind, delta)) continue
    violations.push({
      guardId: guard.id, ruleId: guard.ruleId, variableKey: forbidKey, onViolate: guard.onViolate,
      reason: 'condition_met',
      message: guard.message,
    })
  }

  return {
    ok: violations.length === 0,
    blocked: violations.some(v => v.onViolate === 'block_recommendation'),
    violations,
    evaluated,
    skipped,
  }
}

/** 从已发布版本的 compiled_json 里取守卫集(缺省空集) */
export function extractGuardSet(compiled: unknown): ControlGuard[] {
  const value = compiled as { artifacts?: { controlGuard?: { guards?: unknown } }, controlGuard?: { guards?: unknown } } | undefined
  const guards = value?.artifacts?.controlGuard?.guards ?? value?.controlGuard?.guards
  if (!Array.isArray(guards)) return []
  return guards.filter((g): g is ControlGuard => !!g && typeof g === 'object'
    && typeof (g as ControlGuard).id === 'string'
    && typeof (g as ControlGuard).ruleId === 'string'
    && !!(g as ControlGuard).when && !!(g as ControlGuard).forbid)
}
