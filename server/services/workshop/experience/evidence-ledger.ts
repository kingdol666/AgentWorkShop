/**
 * 宿主证据门(Task 3)。
 *
 * 独立性只由**宿主派生的支持单元**决定(supportUnitId:run/批次/种子),不是 taskId,
 * 更不是模型自述:同源重试、同一运行的分片、复述曾注入的主张都不计新增外部证据;
 * 主张形成前的观测不能反过来支持该主张;环境不一致的证据不得混用。
 */
import type { EvidenceDecision, EvidenceRef, TrustedLearningContext } from './types'

export interface ClassifyOptions {
  /** 主张首次形成时间;早于此的观测不计支持 */
  claimOriginTime?: string
}

const envMatches = (ref: EvidenceRef, context: TrustedLearningContext): boolean =>
  ref.environment === context.environment

export function classifyEvidence(
  refs: readonly EvidenceRef[],
  context: TrustedLearningContext,
  options: ClassifyOptions = {},
): EvidenceDecision {
  const excludedReasons: string[] = []
  const support = new Set<string>()
  const refute = new Set<string>()
  const origin = options.claimOriginTime ? Date.parse(options.claimOriginTime) : null

  for (const ref of refs) {
    if (!envMatches(ref, context)) {
      excludedReasons.push(`${ref.id}:ENVIRONMENT_MISMATCH`)
      continue
    }
    if (origin !== null && Number.isFinite(origin)) {
      const at = Date.parse(ref.observedAt)
      if (!Number.isFinite(at) || at < origin) {
        excludedReasons.push(`${ref.id}:BEFORE_CLAIM_ORIGIN`)
        continue
      }
    }
    if ((ref.restatesVersionIds ?? []).length > 0) {
      excludedReasons.push(`${ref.id}:REPEATED_INJECTED_CLAIM`)
      continue
    }
    if ((ref.betaAncestors ?? []).length > 0) {
      excludedReasons.push(`${ref.id}:BETA_ANCESTOR`)
      continue
    }
    if (!ref.supportUnitId?.trim()) {
      excludedReasons.push(`${ref.id}:NO_SUPPORT_UNIT`)
      continue
    }
    if (ref.polarity === 'unknown') {
      excludedReasons.push(`${ref.id}:UNKNOWN_POLARITY`)
      continue
    }
    if (ref.polarity === 'support') support.add(ref.supportUnitId)
    else refute.add(ref.supportUnitId)
  }
  return {
    supportUnitIds: [...support].sort(),
    refuteUnitIds: [...refute].filter(u => !support.has(u)).sort(),
    excludedReasons,
  }
}

/** E2 量化门槛:主张形成后至少两个**独立**支持单元,且没有任何反证单元 */
export function hasIndependentSupport(decision: EvidenceDecision, minimum = 2): boolean {
  return decision.supportUnitIds.length >= minimum && decision.refuteUnitIds.length === 0
}
