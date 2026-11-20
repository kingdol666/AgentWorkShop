/**
 * 可归因的宿主评测(Task 5)。
 *
 * 旧口径:客户端逐样本自报来源,复算只能证明"数字自洽",不能证明宿主真的跑过,
 * 也无法排除重复观测、同一运行跨臂泄漏或缺成本观测。这里冻结估计口径并强制:
 *  - 留出单元与开发单元不相交(同 run 复用作留出 → BLOCKED);
 *  - 分母必须等于 success+failed+timedOut+interrupted(不允许只报成功);
 *  - 各臂独立(一臂的更新对另一臂不可见);
 *  - 只有 host 来源的评测才可作发布证据;客户端旧台账恒 releaseEligible=false。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createHarnessBenchRunRepo } from '../db/harness-bench.repo'

export type EvaluationStatus = 'PASS' | 'FAIL' | 'BLOCKED'

export interface FrozenEvaluationSpec {
  /** 冻结:数据/模型/策略版本 */
  dataVersions: Readonly<Record<string, string>>
  modelVersion: string
  policyVersion: string
  /** 四臂:A 无经验,B 历史召回(仅隔离回放),C 新解析,D=C+人工审核部署 */
  arms: ReadonlyArray<'A' | 'B' | 'C' | 'D'>
  primaryEndpoint: string
  minEffect: number
  nonInferiorityBound: number
  maxCostDelta: number
  alpha: number
  minSampleSize: number
  developmentUnits: readonly string[]
  holdoutUnits: readonly string[]
  /** host = 宿主执行并留原始证据;client = 客户端自报(仅展示) */
  provenance: 'host' | 'client'
  /** 预先声明的总分母(用于核对逐臂计数是否漏报) */
  declaredDenominator?: number
}

export interface ArmOutcome {
  arm: 'A' | 'B' | 'C' | 'D'
  success: number
  failed: number
  timedOut: number
  interrupted: number
  /** 主终点效应(C−B 口径) */
  effect: number
  cost: number
  /** 该臂在运行中是否看到过其他臂的更新(独立事件流/索引/缓存失效检查) */
  sawOtherArmUpdates?: boolean
}

export interface EvaluationRunRef {
  runId: string
  status: EvaluationStatus
  blockers: string[]
  denominator: number
  manifestHash: string
  releaseEligible: boolean
  provenance: 'host' | 'client'
  /** 真实测量:C−B 主终点效应与成本差;臂缺失时 null(不编造数字) */
  effect: number | null
  costDelta: number | null
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const specHash = (spec: FrozenEvaluationSpec): string => sha256(JSON.stringify({
  dataVersions: spec.dataVersions, modelVersion: spec.modelVersion, policyVersion: spec.policyVersion,
  arms: [...spec.arms].sort(), primaryEndpoint: spec.primaryEndpoint, minEffect: spec.minEffect,
  nonInferiorityBound: spec.nonInferiorityBound, maxCostDelta: spec.maxCostDelta, alpha: spec.alpha,
  minSampleSize: spec.minSampleSize, developmentUnits: [...spec.developmentUnits].sort(),
  holdoutUnits: [...spec.holdoutUnits].sort(), provenance: spec.provenance,
}))

export function planExperienceEvaluation(spec: FrozenEvaluationSpec, outcomes: readonly ArmOutcome[] = []): EvaluationRunRef {
  const blockers: string[] = []
  const holdout = new Set(spec.holdoutUnits)
  if (spec.holdoutUnits.some(u => spec.developmentUnits.includes(u)) || holdout.size !== spec.holdoutUnits.length) {
    blockers.push('HOLDOUT_LEAK: 留出单元与开发单元重叠或重复')
  }
  if (spec.holdoutUnits.length === 0) blockers.push('HOLDOUT_MISSING: 未声明独立留出集')
  if (!spec.dataVersions || Object.keys(spec.dataVersions).length === 0) blockers.push('DATA_VERSION_UNPINNED')
  if (!spec.modelVersion.trim() || !spec.policyVersion.trim()) blockers.push('VERSION_UNPINNED')
  if (spec.provenance !== 'host') blockers.push('CLIENT_PROVENANCE: 客户端评测不得作为发布证据')
  if (outcomes.some(o => o.sawOtherArmUpdates === true)) blockers.push('ARM_LEAK: 臂间可见彼此更新')
  const denominator = outcomes.reduce((n, o) => n + o.success + o.failed + o.timedOut + o.interrupted, 0)
  if (spec.declaredDenominator !== undefined && spec.declaredDenominator !== denominator) {
    blockers.push(`DENOMINATOR_MISMATCH: 声明 ${spec.declaredDenominator} ≠ 逐臂合计 ${denominator}`)
  }
  if (outcomes.length > 0 && denominator < spec.minSampleSize) {
    blockers.push(`SAMPLE_INSUFFICIENT: ${denominator} < ${spec.minSampleSize}`)
  }
  const primary = outcomes.find(o => o.arm === 'C')
  const baseline = outcomes.find(o => o.arm === 'B')
  let status: EvaluationStatus = blockers.length > 0 ? 'BLOCKED' : 'FAIL'
  // 真实测量:C−B 主终点效应与成本差;未跑出臂时 null(绝不编造数字)
  const effect = primary && baseline ? primary.effect - baseline.effect : null
  const costDelta = primary && baseline ? primary.cost - baseline.cost : null
  if (blockers.length === 0 && primary && baseline && effect !== null && costDelta !== null) {
    if (effect >= spec.minEffect && costDelta <= spec.maxCostDelta) status = 'PASS'
    else if (effect >= -Math.abs(spec.nonInferiorityBound) && costDelta <= spec.maxCostDelta) status = 'PASS'
  }
  return {
    runId: `evr-${specHash(spec).slice(0, 16)}`,
    status,
    blockers: [...new Set(blockers)],
    denominator,
    manifestHash: specHash(spec),
    releaseEligible: status === 'PASS' && spec.provenance === 'host',
    provenance: spec.provenance,
    effect,
    costDelta,
  }
}

/** 宿主执行:每个臂独立运行并汇总;执行器缺失即 BLOCKED(不用夹具补结论) */
export async function runExperienceEvaluation(
  spec: FrozenEvaluationSpec,
  deps: { runArm: (arm: ArmOutcome['arm']) => Promise<Omit<ArmOutcome, 'arm'>> },
): Promise<EvaluationRunRef> {
  const outcomes: ArmOutcome[] = []
  for (const arm of spec.arms) {
    try {
      outcomes.push({ arm, ...(await deps.runArm(arm)) })
    }
    catch (err) {
      return {
        runId: `evr-${specHash(spec).slice(0, 16)}`,
        status: 'BLOCKED',
        blockers: [`ARM_EXECUTION_FAILED:${arm}:${err instanceof Error ? err.message : String(err)}`],
        denominator: outcomes.reduce((n, o) => n + o.success + o.failed + o.timedOut + o.interrupted, 0),
        manifestHash: specHash(spec),
        releaseEligible: false,
        provenance: spec.provenance,
        effect: null,
        costDelta: null,
      }
    }
  }
  return planExperienceEvaluation(spec, outcomes)
}

/**
 * 把宿主评测结果登记为 Profile 晋升可消费的台账行。
 * kind='host-evaluation' 是晋升门的宿主来源标记;其余 kind 一律视为客户端台账。
 */
export function recordHostEvaluationEvidence(
  db: DatabaseSync,
  input: { channelId: string, profileId: string, baselineProfileId?: string, evidence: EvaluationRunRef, createdBy: string },
): { ok: boolean, benchRunId?: string, reasons: string[] } {
  if (!input.evidence.releaseEligible) {
    return { ok: false, reasons: [`宿主评测不可作为发布证据:${input.evidence.status} ${input.evidence.blockers.join(';')}`] }
  }
  const now = new Date().toISOString()
  // 台账只写**真实测量值**:pValue=null(未做显著性检验),效应/成本取冻结口径的 C−B 实测;
  // 晋升门对宿主来源运行按预注册非劣界判定,不再消费任何编造的显著性数字。
  const run = createHarnessBenchRunRepo(db).create({
    channelId: input.channelId,
    profileId: input.profileId,
    baselineProfileId: input.baselineProfileId ?? '',
    kind: 'host-evaluation',
    status: 'completed',
    pValue: null,
    primaryDelta: input.evidence.effect ?? 0,
    costDelta: input.evidence.costDelta ?? 0,
    pairs: input.evidence.denominator,
    excluded: 0,
    seedsJson: '[]',
    perSeedJson: '[]',
    artifactSha256: input.evidence.manifestHash,
    createdBy: input.createdBy,
    createdAt: now,
    completedAt: now,
  })
  return { ok: true, benchRunId: run.id, reasons: [] }
}
