/**
 * 建议生命周期(G3.7 / C10):
 *  - 不可变、带 valid_until;
 *  - 缺 UQ/OOD 证据 → unverified,UI/回执必须原样显示;
 *  - 工况/配方/权限/revision 变化 → expired(不删除,保留审计)。
 */
import type { Recommendation, SolveCandidate } from './contracts'
import { recommendationLabel } from './contracts'
import { getRunRepo } from './run.repo'
import { coverageThreshold } from './uq-evidence'

export const RECOMMENDATION_TTL_MS = 15 * 60_000

/** 建议 UQ 证据快照 = 工件 uq + artifactHash 锚 + 本次上下文 inputDistance(D2/D4/D5 单源) */
export interface UqEvidence {
  method?: 'split_conformal' | 'empirical_max'
  qhatPerCv?: number[]
  /** test 段实测 min_j coverage(旧字段 coverage 兼容读取) */
  coverageTest?: number
  coverage?: number
  alpha?: number
  horizon?: number
  nValBlocks?: number
  nValRuns?: number
  nTestBlocks?: number
  nTestRuns?: number
  nUniqueTestSteps?: number
  safetyFactor?: number
  calibratedAt?: string
  artifactHash?: string
  calibrationFresh?: boolean
  inputDistance?: number | null
  evidenceVersion?: string
}

const OOD_DISTANCE_LIMIT = 3

/** 只有显式携带完整校准证据才算 verified;缺省/不完整一律 unverified(不伪造)。 */
export function classifyRecommendation(input: {
  evidenceSource: 'simulation' | 'real' | 'unassessed'
  uqEvidence: UqEvidence | null
  candidateFeasible: boolean
}): { status: 'verified' | 'unverified', reason: string } {
  if (!input.candidateFeasible) return { status: 'unverified', reason: '候选未通过独立约束校验' }
  if (input.evidenceSource !== 'simulation' && input.evidenceSource !== 'real') return { status: 'unverified', reason: '证据来源尚未评估' }
  const uq = input.uqEvidence
  if (!uq) return { status: 'unverified', reason: '缺工件 UQ 证据(旧工件/样本不足未发证)' }
  const coverage = uq.coverageTest ?? uq.coverage
  if (coverage == null || !Number.isFinite(coverage) || coverage < 0 || coverage > 1) return { status: 'unverified', reason: 'UQ coverage 必须是 [0,1] 范围内的有限数值' }
  // D3 门限:0.8 硬底 + 分块修正;empirical_max 必须 1.0
  const threshold = coverageThreshold({ method: uq.method ?? 'split_conformal', nTestRuns: uq.nTestRuns ?? 1 })
  if (coverage < threshold) return { status: 'unverified', reason: `UQ coverage 不足(${coverage} < ${threshold.toFixed(3)},method=${uq.method ?? 'split_conformal'})` }
  if (uq.calibrationFresh !== true) return { status: 'unverified', reason: 'UQ 校准已过期或未评估' }
  if (uq.inputDistance == null) return { status: 'unverified', reason: 'inputDistance 未评估(norm 缺失/列序不符);不得按 0 乐观处理' }
  if (!Number.isFinite(uq.inputDistance) || uq.inputDistance < 0) return { status: 'unverified', reason: 'inputDistance 必须是非负有限数值' }
  if (uq.inputDistance > OOD_DISTANCE_LIMIT) return { status: 'unverified', reason: `当前操作点偏离训练分布(OOD):inputDistance=${uq.inputDistance.toFixed(2)} > ${OOD_DISTANCE_LIMIT}` }
  return { status: 'verified', reason: 'UQ/OOD 证据完整(val 校准/test 实证,coverage 达 D3 门,操作点在域内)' }
}

export function createRecommendation(input: {
  runId: string
  candidate: SolveCandidate
  candidateId: string
  problemIrHash: string
  modelArtifactHash: string
  evidenceSource: 'simulation' | 'real' | 'unassessed'
  uqEvidence: UqEvidence | null
}): Recommendation {
  const classified = classifyRecommendation({
    evidenceSource: input.evidenceSource,
    uqEvidence: input.uqEvidence,
    candidateFeasible: input.candidate.feasible,
  })
  const id = `orec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  return getRunRepo().insertRecommendation({
    id,
    runId: input.runId,
    candidateId: input.candidateId,
    problemIrHash: input.problemIrHash,
    modelArtifactHash: input.modelArtifactHash,
    evidenceSource: input.evidenceSource,
    uqEvidence: input.uqEvidence as Record<string, unknown> | null,
    status: classified.status,
    validUntil: new Date(Date.now() + RECOMMENDATION_TTL_MS).toISOString(),
  })
}

export function expireRecommendations(filter: { runId?: string, bindingId?: string, problemIrHash?: string }): number {
  return getRunRepo().expireWhere(filter)
}

export function assertRecommendationUsable(rec: Recommendation): Recommendation {
  const expired = Date.parse(rec.validUntil) <= Date.now()
  if (expired && rec.status !== 'expired') {
    getRunRepo().expireWhere({ runId: rec.runId })
    return { ...rec, status: 'expired', statusLabel: recommendationLabel('expired') }
  }
  if (rec.status === 'expired') return rec
  return rec
}
