/**
 * DAQ 批次质量与外部任务终态(Task 11)。
 *
 * 缺数不可见 = 未知被当成通过。批次质量记录预期/有效/丢失样本与缺口窗,
 * 明确哪些用途被阻断(控制证据/训练);外部任务把「执行终态」与「产物有效性」
 * 分开:上游 completed 就忠实记录 completed,但缺产物时另记 artifactStatus 且不可当验收证据。
 */

export interface BatchQualityInput {
  expectedCount: number
  validCount: number
  droppedCount: number
  /** 缺口窗口(ms 级时间戳区间),用于判读关键采样断点 */
  gapWindows?: Array<{ from: number, to: number }>
  criticalGapMs?: number
}

export interface BatchQuality {
  expectedCount: number
  validCount: number
  droppedCount: number
  gapWindows: Array<{ from: number, to: number }>
  coverage: number
  state: 'complete' | 'degraded' | 'insufficient'
  eligibleForControlEvidence: boolean
  eligibleForTraining: boolean
}

export function assessBatchQuality(input: BatchQualityInput): BatchQuality {
  const expected = Math.max(0, Math.trunc(input.expectedCount))
  const valid = Math.max(0, Math.trunc(input.validCount))
  const dropped = Math.max(0, Math.trunc(input.droppedCount))
  const gaps = input.gapWindows ?? []
  const criticalGapMs = input.criticalGapMs ?? 60_000
  const coverage = expected === 0 ? 0 : Math.min(1, valid / expected)
  const hasCriticalGap = gaps.some(g => Math.abs(g.to - g.from) >= criticalGapMs)
  const insufficient = expected === 0 || coverage < 0.5
  const degraded = !insufficient && (coverage < 0.95 || dropped > 0 || gaps.length > 0)
  return {
    expectedCount: expected,
    validCount: valid,
    droppedCount: dropped,
    gapWindows: gaps,
    coverage,
    state: insufficient ? 'insufficient' : degraded ? 'degraded' : 'complete',
    // 关键缺口/覆盖不足 → 不能作控制证据;训练还要求无关键缺口
    eligibleForControlEvidence: !insufficient && !hasCriticalGap,
    eligibleForTraining: !insufficient && !degraded && dropped === 0 && gaps.length === 0,
  }
}

export type ExternalJobOutcome = 'accepted' | 'running' | 'completed' | 'overdue' | 'failed' | 'stopped' | 'unknown'
export type ArtifactStatus = 'present' | 'missing' | 'unverified' | 'invalid'

export interface ExternalJobObservation {
  accepted: boolean
  /** 上游明确给出的终态(completed/failed/stopped);null = 尚未终态 */
  terminal: 'completed' | 'failed' | 'stopped' | null
  overdue: boolean
  artifact: ArtifactStatus
  /** 内部 Agent 不可用时的降级方式(只允许只读) */
  agentUnavailable?: boolean
}

export interface ExternalJobProjection {
  outcome: ExternalJobOutcome
  artifactStatus: ArtifactStatus
  /** completed 但产物缺失/未验证时,不能作为验收证据 */
  acceptanceEligible: boolean
  documentFallbackMode: 'none' | 'readonly'
  reasons: string[]
}

export function projectExternalJob(obs: ExternalJobObservation): ExternalJobProjection {
  const reasons: string[] = []
  let outcome: ExternalJobOutcome
  if (obs.terminal === 'completed') outcome = 'completed'
  else if (obs.terminal === 'failed') outcome = 'failed'
  else if (obs.terminal === 'stopped') outcome = 'stopped'
  else if (obs.overdue) outcome = 'overdue'
  else if (obs.accepted) outcome = 'running'
  else outcome = 'unknown'

  if (!obs.accepted && outcome === 'unknown') reasons.push('NOT_ACCEPTED')
  if (outcome === 'overdue') reasons.push('OVERDUE: 未达终态,不得按完成计')
  if (outcome === 'completed' && obs.artifact !== 'present') {
    reasons.push(`ARTIFACT_${obs.artifact.toUpperCase()}: 终态可信但产物不可用于验收`)
  }
  return {
    outcome,
    artifactStatus: obs.artifact,
    acceptanceEligible: outcome === 'completed' && obs.artifact === 'present',
    documentFallbackMode: obs.agentUnavailable ? 'readonly' : 'none',
    reasons,
  }
}
