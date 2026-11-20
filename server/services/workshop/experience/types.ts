/**
 * 受治理的产品经验复用 —— 持久契约(实施计划 §2 / Task 2–4)。
 *
 * 铁律:
 *  - 事实、主张、证据、验证与部署分开;哈希只证明内容完整性,不证明事实真实;
 *  - 生命周期(candidate→evaluating→validated)与部署(none→shadow→canary→active)独立;
 *  - `legacy-unverified` 永不自动注入,即使历史状态曾是 validated;
 *  - Beta 来源经聚合/摘要/handoff 仍保留祖先标记,当前 ADR 下不得晋升。
 */

/** 生命周期(证据维度) */
export type ExperienceLifecycle
  = | 'candidate'
    | 'evaluating'
    | 'validated'
    | 'contested'
    | 'quarantined'
    | 'retired'
    | 'expired'
    | 'superseded'
    | 'legacy-unverified'

/** 部署维度(与生命周期独立) */
export type ExperienceDeployment = 'none' | 'shadow' | 'canary' | 'active' | 'withdrawn'

export type LearningEnvironment = 'simulation' | 'offline' | 'physical_hil' | 'production' | 'unknown'

export type ExperienceScopeKind = 'agent' | 'channel' | 'line' | 'product' | 'global'

export interface ExperienceScope {
  kind: ExperienceScopeKind
  key: string
}

/** 结构化主张:兼容性判定只认这些字段,语义相似只供提议 */
export interface ExperienceClaim {
  /** 工业 productId 或设计对象版本键;空串=未限定 */
  productId: string
  /** 配方修订(空串=未限定) */
  recipeRevision: string
  /** 工艺变量名(如 保压压力SP) */
  variable: string
  unit: string
  direction: 'increase' | 'decrease' | 'stable' | 'nonmonotonic'
  condition: string
  polarity: 'support' | 'refute'
}

/** 宿主认证的可信上下文(宿主构造,不信 prompt) */
export interface TrustedLearningContext {
  actor: string
  channelId: string
  sessionId: string
  /** 可撤销授权版本(单调递增);不能用绑定修订代替 */
  authorizationEpoch: number
  /** 通用对象权威标识(Project/设计对象/产线产品) */
  subjectRef: string
  environment: LearningEnvironment
  industrial?: {
    lineId: string
    productId: string
    recipeRevision?: string
    runId?: string
  }
}

export type ContextResolution
  = | { ok: true, context: TrustedLearningContext }
    | { ok: false, reason: 'TRUSTED_CONTEXT_UNAVAILABLE' }

/** 证据引用:来源/环境/独立单元/时间窗/极性/血缘 */
export interface EvidenceRef {
  id: string
  sourceKind: 'task' | 'human' | 'model' | 'external' | 'beta'
  environment: LearningEnvironment
  observedAt: string
  /** 宿主派生的独立单元(重复观测必须同 unit):runId/批次/种子 */
  supportUnitId: string
  taskId?: string
  runId?: string
  batchId?: string
  attempt?: number
  polarity: 'support' | 'refute' | 'unknown'
  /** Beta 祖先(经摘要/handoff 传递后仍必须保留) */
  betaAncestors?: readonly string[]
  /** 该证据来自此前注入的经验复述时记录版本 id(不计新增外部证据) */
  restatesVersionIds?: readonly string[]
}

export interface EvidenceDecision {
  supportUnitIds: string[]
  refuteUnitIds: string[]
  excludedReasons: string[]
}

/** 版本草稿:同一事务内写入版本与证据绑定 */
export interface VersionDraft {
  experienceId: string
  scope: ExperienceScope
  claim: ExperienceClaim
  content: string
  observedAt: string
  evidence: readonly EvidenceRef[]
  idempotencyKey: string
  betaAncestors?: readonly string[]
}

/** 不可变经验版本 */
export interface ExperienceVersion {
  experienceId: string
  versionId: string
  claimOriginId: string
  scope: ExperienceScope
  claim: ExperienceClaim
  contentHash: string
  evidenceSnapshotHash: string
  lifecycle: ExperienceLifecycle
  deployment: ExperienceDeployment
  claimOriginTime: string
  betaAncestors: readonly string[]
  createdAt: string
}

export interface ClaimClusterProposal {
  compatible: boolean
  reasons: string[]
  versionIds: string[]
}

export interface ArtifactUseDecision {
  decisionId: string
  versionIds: string[]
  contextEpoch: number
  policyVersion: string
  reason: string
}

export interface ExperienceQuery {
  text: string
  purpose: 'automatic' | 'explicit' | 'review'
  limit: number
}

export interface ExperienceResolutionItem {
  versionId: string
  experienceId: string
  title: string
  content: string
  lifecycle: ExperienceLifecycle
  deployment: ExperienceDeployment
  /** 显式获取未部署的 validated 时标记为参考而非执行 */
  referenceOnly: boolean
}

export interface ExperienceResolution {
  items: ExperienceResolutionItem[]
  decision: ArtifactUseDecision
}

export const EXPERIENCE_VERSION_CONFLICT = 'EXPERIENCE_VERSION_CONFLICT'

export class ExperienceVersionConflictError extends Error {
  readonly code = EXPERIENCE_VERSION_CONFLICT
  constructor(message: string) {
    super(message)
    this.name = 'ExperienceVersionConflictError'
  }
}
