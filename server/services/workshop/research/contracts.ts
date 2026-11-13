import type {
  CLAIM_LEVELS,
  EVIDENCE_KINDS,
  EVIDENCE_QUALITY,
  ContextAdapterCapability,
  ContextRef,
  ContextScope,
  ContextWindow,
  EvidenceEnvelope,
  Redaction,
} from '@/server/services/workshop/context/contracts'

export const RESEARCH_STATES = [
  'draft',
  'planned',
  'read-approval',
  'running',
  'verdict',
  'evidence-candidate',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const

export type ResearchState = typeof RESEARCH_STATES[number]
export type ResearchTerminalState = Extract<ResearchState, 'completed' | 'failed' | 'cancelled' | 'expired'>
export type ResearchCapability = ContextAdapterCapability
export type ResearchEvidenceKind = typeof EVIDENCE_KINDS[number]
export type ResearchEvidenceQuality = typeof EVIDENCE_QUALITY[number]
export type ResearchClaimLevel = typeof CLAIM_LEVELS[number]

/** Capabilities permitted when a request does not explicitly opt into a set. */
export const SAFE_READ_ONLY_CAPABILITIES = Object.freeze([
  'discover',
  'snapshot',
  'observe',
  'query',
  'verify',
] as const satisfies readonly ResearchCapability[])

export interface ResearchBudgetInput {
  maxDurationMs?: number
  maxSteps?: number
  maxBytes?: number
  maxSources?: number
  maxOutputBytes?: number
  maxRsiIterations?: number
}

export interface ResearchBudget {
  readonly maxDurationMs: number
  readonly maxSteps: number
  readonly maxBytes: number
  readonly maxSources: number
  readonly maxOutputBytes: number
  readonly maxRsiIterations: number
}

export interface ResearchRequest {
  readonly id: string
  readonly idempotencyKey: string
  readonly objective: string
  readonly question: string
  readonly subjectRefs: readonly ContextRef[]
  readonly scope: ContextScope
  readonly contextSnapshotId?: string
  readonly researchCaseId?: string
  readonly allowedCapabilities?: readonly ResearchCapability[]
  readonly budget?: ResearchBudgetInput
}

export interface ResearchStep {
  readonly id: string
  readonly adapterId: string
  readonly capability: ResearchCapability
  readonly payload: unknown
  readonly sourceRef: string
  readonly sourceRevision?: string
  readonly subjectRefs?: readonly ContextRef[]
  readonly window?: ContextWindow
  readonly kind?: ResearchEvidenceKind
  readonly quality?: ResearchEvidenceQuality
  readonly redaction?: Redaction
  readonly rsiIteration?: number
}

export interface ResearchPlan {
  readonly id: string
  readonly steps: readonly ResearchStep[]
  readonly verdict?: string
}

export interface ResearchVerdict {
  readonly summary: string
  readonly claimLevel: 'candidate'
  readonly evidenceIds: readonly string[]
}

export interface ResearchCounters {
  readonly steps: number
  readonly bytes: number
  readonly sources: number
  readonly outputBytes: number
  readonly rsiIterations: number
}

export interface ResearchRun {
  readonly id: string
  readonly idempotencyKey: string
  readonly state: ResearchState
  readonly objective: string
  readonly question: string
  readonly subjectRefs: readonly ContextRef[]
  readonly scope: ContextScope
  readonly contextSnapshotId?: string
  readonly researchCaseId?: string
  readonly allowedCapabilities: readonly ResearchCapability[]
  readonly budget: ResearchBudget
  readonly plan?: ResearchPlan
  readonly counters: ResearchCounters
  readonly evidenceIds: readonly string[]
  readonly verdict?: ResearchVerdict
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: string
  readonly startedAt?: string
  readonly endedAt?: string
}

export interface ResearchCreateResult {
  readonly run: ResearchRun
  readonly idempotent: boolean
}

export interface ResearchExecutionOptions {
  readonly signal?: AbortSignal
}

export interface ResearchOrchestratorOptions {
  readonly now?: () => string
  readonly createId?: (prefix: string) => string
}

export interface CandidateEvidenceEnvelope extends Readonly<EvidenceEnvelope> {
  readonly candidateOnly: true
  readonly contentHash: string
}

export type CandidateEvidenceRef = Pick<CandidateEvidenceEnvelope, 'id' | 'payloadHash' | 'contentHash'>
