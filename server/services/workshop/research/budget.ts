import { canonicalJson } from '@/shared/context/hash'
import type { ResearchBudget, ResearchBudgetInput, ResearchCounters } from './contracts'

export const RESEARCH_BUDGET_DEFAULTS: ResearchBudget = Object.freeze({
  maxDurationMs: 60_000,
  maxSteps: 32,
  maxBytes: 1_048_576,
  maxSources: 16,
  maxOutputBytes: 524_288,
  maxRsiIterations: 8,
})

export const RESEARCH_BUDGET_LIMITS: ResearchBudget = Object.freeze({
  maxDurationMs: 900_000,
  maxSteps: 256,
  maxBytes: 16_777_216,
  maxSources: 64,
  maxOutputBytes: 8_388_608,
  maxRsiIterations: 32,
})

export const RESEARCH_BUDGET_ERROR_CODES = {
  INVALID: 'RESEARCH_BUDGET_INVALID',
  EXCEEDED: 'RESEARCH_BUDGET_EXCEEDED',
} as const

export class ResearchBudgetError extends Error {
  readonly code: typeof RESEARCH_BUDGET_ERROR_CODES[keyof typeof RESEARCH_BUDGET_ERROR_CODES]
  readonly metric?: keyof ResearchCounters | 'durationMs'
  readonly limit?: number
  readonly actual?: number

  constructor(
    code: typeof RESEARCH_BUDGET_ERROR_CODES[keyof typeof RESEARCH_BUDGET_ERROR_CODES],
    message: string,
    details: { metric?: ResearchBudgetError['metric'], limit?: number, actual?: number } = {},
  ) {
    super(message)
    this.name = 'ResearchBudgetError'
    this.code = code
    this.metric = details.metric
    this.limit = details.limit
    this.actual = details.actual
  }
}

function positiveInteger(value: unknown, field: string, limit: number): number {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > limit) {
    throw new ResearchBudgetError(RESEARCH_BUDGET_ERROR_CODES.INVALID, `${field} must be a positive integer no greater than ${limit}`, { metric: field as keyof ResearchCounters, limit, actual: typeof value === 'number' ? value : undefined })
  }
  return Number(value)
}

export function normalizeResearchBudget(input: ResearchBudgetInput = {}): ResearchBudget {
  const output = {
    maxDurationMs: input.maxDurationMs ?? RESEARCH_BUDGET_DEFAULTS.maxDurationMs,
    maxSteps: input.maxSteps ?? RESEARCH_BUDGET_DEFAULTS.maxSteps,
    maxBytes: input.maxBytes ?? RESEARCH_BUDGET_DEFAULTS.maxBytes,
    maxSources: input.maxSources ?? RESEARCH_BUDGET_DEFAULTS.maxSources,
    maxOutputBytes: input.maxOutputBytes ?? RESEARCH_BUDGET_DEFAULTS.maxOutputBytes,
    maxRsiIterations: input.maxRsiIterations ?? RESEARCH_BUDGET_DEFAULTS.maxRsiIterations,
  }
  return Object.freeze({
    maxDurationMs: positiveInteger(output.maxDurationMs, 'maxDurationMs', RESEARCH_BUDGET_LIMITS.maxDurationMs),
    maxSteps: positiveInteger(output.maxSteps, 'maxSteps', RESEARCH_BUDGET_LIMITS.maxSteps),
    maxBytes: positiveInteger(output.maxBytes, 'maxBytes', RESEARCH_BUDGET_LIMITS.maxBytes),
    maxSources: positiveInteger(output.maxSources, 'maxSources', RESEARCH_BUDGET_LIMITS.maxSources),
    maxOutputBytes: positiveInteger(output.maxOutputBytes, 'maxOutputBytes', RESEARCH_BUDGET_LIMITS.maxOutputBytes),
    maxRsiIterations: positiveInteger(output.maxRsiIterations, 'maxRsiIterations', RESEARCH_BUDGET_LIMITS.maxRsiIterations),
  })
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

export function assertBudgetMetric(
  metric: keyof ResearchCounters,
  actual: number,
  limit: number,
): void {
  if (!Number.isSafeInteger(actual) || actual < 0) {
    throw new ResearchBudgetError(RESEARCH_BUDGET_ERROR_CODES.INVALID, `${metric} must be a non-negative safe integer`, { metric, limit, actual })
  }
  if (actual > limit) {
    throw new ResearchBudgetError(RESEARCH_BUDGET_ERROR_CODES.EXCEEDED, `${metric} budget exceeded`, { metric, limit, actual })
  }
}

export function assertDuration(startedAtMs: number, nowMs: number, budget: ResearchBudget): void {
  const elapsed = Math.max(0, nowMs - startedAtMs)
  if (elapsed > budget.maxDurationMs) {
    throw new ResearchBudgetError(RESEARCH_BUDGET_ERROR_CODES.EXCEEDED, 'duration budget exceeded', { metric: 'durationMs', limit: budget.maxDurationMs, actual: elapsed })
  }
}

export function assertCounters(counters: ResearchCounters, budget: ResearchBudget): void {
  assertBudgetMetric('steps', counters.steps, budget.maxSteps)
  assertBudgetMetric('bytes', counters.bytes, budget.maxBytes)
  assertBudgetMetric('sources', counters.sources, budget.maxSources)
  assertBudgetMetric('outputBytes', counters.outputBytes, budget.maxOutputBytes)
  assertBudgetMetric('rsiIterations', counters.rsiIterations, budget.maxRsiIterations)
}
