/**
 * 本体证据候选与 AML 工件分轨复用(Task 12)。
 *
 * 铁律:
 *  - 文档/交付/干预证据只能生成**带来源的候选**;发布仍走现有独立人工门;
 *  - 「没有声明边」= 未知,不是否证;显式否证必须有证据且带适用窗;
 *  - 工件可推演不等于可执行:缺关键约束可观测性 / 跨配方 / 缺 ensemble 成员 → 不可用。
 */
import { proposeClaimCluster } from './claim-cluster'
import type { EvidenceRef, TrustedLearningContext, ExperienceVersion } from './types'

export type ConstraintVerdict = 'verified' | 'violated' | 'unobservable' | 'unknown'

export interface OntologyDiffCandidate {
  kind: 'entity' | 'relation' | 'unit'
  key: string
  value: string
  sourceEvidenceIds: string[]
}

export interface OntologyProposal {
  baseVersion: number | null
  diff: OntologyDiffCandidate[]
  support: string[]
  conflicts: string[]
  blockedReasons: string[]
}

const ENTITY_RE = /(?:设备|节点|工序|设备组)[「:：]?\s*([\w\u4e00-\u9fa5-]{2,20})/g

/** 从证据文本提取实体候选;命名空间/量纲/绑定冲突由发布前人工门复核 */
export function proposeOntologyDiff(
  context: TrustedLearningContext,
  evidence: readonly EvidenceRef[],
  opts: { baseVersion?: number | null, texts?: readonly string[] } = {},
): OntologyProposal {
  const blockedReasons: string[] = []
  const support: string[] = []
  const conflicts: string[] = []
  const diff: OntologyDiffCandidate[] = []
  if (!context.actor) blockedReasons.push('TRUSTED_CONTEXT_UNAVAILABLE')
  if (evidence.some(e => (e.betaAncestors ?? []).length > 0)) blockedReasons.push('BETA_ANCESTOR_PRESENT')
  for (const ref of evidence) {
    if (ref.polarity === 'support') support.push(ref.id)
    else if (ref.polarity === 'refute') conflicts.push(ref.id)
  }
  if (conflicts.length > 0) blockedReasons.push('CONFLICTING_EVIDENCE_REQUIRES_REVIEW')
  if (support.length === 0) blockedReasons.push('NO_SUPPORTING_EVIDENCE')
  for (const text of opts.texts ?? []) {
    for (const match of text.matchAll(ENTITY_RE)) {
      const key = match[1]?.trim()
      if (!key) continue
      if (!diff.some(d => d.kind === 'entity' && d.key === key)) {
        diff.push({ kind: 'entity', key, value: text.slice(0, 120), sourceEvidenceIds: support })
      }
    }
  }
  return { baseVersion: opts.baseVersion ?? null, diff, support, conflicts, blockedReasons }
}

/**
 * 约束观测四态:未知/不可观测不得当通过,也不得当失败。
 */
export function evaluateConstraintVerdict(input: {
  declaredEdge: boolean
  refutedEdge: boolean
  observedCoupled: boolean | null
  observationWindowValid: boolean
}): ConstraintVerdict {
  if (!input.observationWindowValid || input.observedCoupled === null) return 'unobservable'
  if (!input.declaredEdge) {
    if (input.refutedEdge) return 'violated'
    return input.observedCoupled ? 'violated' : 'unknown'
  }
  return input.observedCoupled ? 'verified' : 'violated'
}

export interface ModelReuseInput {
  modelLineage: { productId: string, recipeRevision: string, datasetHash: string, artifactHash: string }
  targetLineage: { productId: string, recipeRevision: string }
  io: { inputUnits: string[], outputUnits: string[], expectedInputUnits: string[], expectedOutputUnits: string[] }
  calibration: 'present' | 'missing'
  criticalGuards: { total: number, observables: number }
  ensembleMembers: { required: number, present: number }
  drift: 'within' | 'exceeded' | 'unknown'
}

export interface ModelReuseDecision {
  modelUsable: boolean
  executable: boolean
  reasons: string[]
}

/** 工件谱系复用:只判「能不能用」,不把推演当物理验证 */
export function assessModelReuse(input: ModelReuseInput): ModelReuseDecision {
  const reasons: string[] = []
  if (input.modelLineage.productId !== input.targetLineage.productId) reasons.push('PRODUCT_MISMATCH')
  if (input.modelLineage.recipeRevision !== input.targetLineage.recipeRevision) reasons.push('RECIPE_MISMATCH')
  if (!input.modelLineage.datasetHash || !input.modelLineage.artifactHash) reasons.push('LINEAGE_HASH_MISSING')
  const sameInputs = input.io.inputUnits.join('|') === input.io.expectedInputUnits.join('|')
  const sameOutputs = input.io.outputUnits.join('|') === input.io.expectedOutputUnits.join('|')
  if (!sameInputs || !sameOutputs) reasons.push('IO_UNIT_MISMATCH')
  if (input.calibration === 'missing') reasons.push('CALIBRATION_MISSING')
  if (input.criticalGuards.observables < input.criticalGuards.total) reasons.push('CRITICAL_GUARD_UNOBSERVABLE')
  if (input.ensembleMembers.present < input.ensembleMembers.required) reasons.push('ENSEMBLE_MEMBER_MISSING')
  if (input.drift === 'exceeded') reasons.push('DRIFT_EXCEEDED')
  if (input.drift === 'unknown') reasons.push('DRIFT_UNKNOWN')
  const modelUsable = reasons.length === 0
  return { modelUsable, executable: modelUsable, reasons }
}

/** 主张簇兼容性(产品/变量/量纲/方向/Beta) */
export function clusterCompatible(versions: readonly ExperienceVersion[]): boolean {
  return proposeClaimCluster(versions).compatible
}
