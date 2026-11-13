import { canonicalHash } from '@/shared/context/hash'
import type { ContextRef, EvidenceEnvelope, Redaction } from '@/server/services/workshop/context/contracts'
import { validateEvidenceEnvelope } from '@/server/services/workshop/context/validator'
import type { CandidateEvidenceEnvelope, CandidateEvidenceRef } from '../research/contracts'

export interface CandidateEvidenceInput {
  readonly id?: string
  readonly kind: EvidenceEnvelope['kind']
  readonly subjectRefs: readonly ContextRef[]
  readonly objectRefs?: readonly ContextRef[]
  readonly attributeRefs?: readonly ContextRef[]
  readonly materialAssignmentRefs?: readonly ContextRef[]
  readonly researchCaseId?: string
  readonly researchRunId?: string
  readonly window?: EvidenceEnvelope['window']
  readonly source: EvidenceEnvelope['source']
  readonly payloadRef: string
  readonly payloadHash: string
  readonly quality: EvidenceEnvelope['quality']
  readonly claimLevel?: 'candidate'
  readonly supports?: readonly string[]
  readonly refutes?: readonly string[]
  readonly accessScope: EvidenceEnvelope['accessScope']
  readonly redaction?: Redaction
  readonly createdAt: string
}

export type CandidateEvidenceNormalizerOptions = {
  readonly createId?: (prefix: string) => string
}

export class CandidateEvidenceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CandidateEvidenceError'
    this.code = code
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen)
  return Object.freeze(value)
}

function generatedId(input: CandidateEvidenceInput, createId?: (prefix: string) => string): string {
  return createId?.('evidence-candidate') ?? `evidence-candidate-${canonicalHash({ source: input.source, payloadHash: input.payloadHash, createdAt: input.createdAt }).slice(0, 24)}`
}

/** Normalize one candidate without persisting or promoting it. */
export function normalizeCandidateEvidence(input: CandidateEvidenceInput, options: CandidateEvidenceNormalizerOptions = {}): CandidateEvidenceEnvelope {
  const envelope: EvidenceEnvelope = {
    id: input.id ?? generatedId(input, options.createId),
    kind: input.kind,
    subjectRefs: [...input.subjectRefs],
    ...(input.objectRefs ? { objectRefs: [...input.objectRefs] } : {}),
    ...(input.attributeRefs ? { attributeRefs: [...input.attributeRefs] } : {}),
    ...(input.materialAssignmentRefs ? { materialAssignmentRefs: [...input.materialAssignmentRefs] } : {}),
    ...(input.researchCaseId ? { researchCaseId: input.researchCaseId } : {}),
    ...(input.researchRunId ? { researchRunId: input.researchRunId } : {}),
    ...(input.window ? { window: { ...input.window } } : {}),
    source: { ...input.source },
    payloadRef: input.payloadRef,
    payloadHash: input.payloadHash,
    quality: input.quality,
    claimLevel: 'candidate',
    ...(input.supports ? { supports: [...input.supports] } : {}),
    ...(input.refutes ? { refutes: [...input.refutes] } : {}),
    accessScope: {
      ...input.accessScope,
      ...(input.accessScope.subjectRefs ? { subjectRefs: [...input.accessScope.subjectRefs] } : {}),
      ...(input.accessScope.objectRefs ? { objectRefs: [...input.accessScope.objectRefs] } : {}),
      ...(input.accessScope.attributeRefs ? { attributeRefs: [...input.accessScope.attributeRefs] } : {}),
      ...(input.accessScope.materialAssignmentRefs ? { materialAssignmentRefs: [...input.accessScope.materialAssignmentRefs] } : {}),
      ...(input.accessScope.tags ? { tags: [...input.accessScope.tags] } : {}),
      ...(input.accessScope.timeWindow ? { timeWindow: { ...input.accessScope.timeWindow } } : {}),
    },
    ...(input.redaction ? { redaction: { ...input.redaction, fields: [...input.redaction.fields] } } : {}),
    createdAt: input.createdAt,
  }
  const issues = validateEvidenceEnvelope(envelope)
  if (issues.length) throw new CandidateEvidenceError('EVIDENCE_CANDIDATE_INVALID', issues.map(item => `${item.path}: ${item.message}`).join('; '))
  const contentHash = canonicalHash(envelope)
  return deepFreeze({ ...envelope, candidateOnly: true, contentHash }) as CandidateEvidenceEnvelope
}

export function candidateEvidenceRef(envelope: CandidateEvidenceEnvelope): CandidateEvidenceRef {
  return Object.freeze({ id: envelope.id, payloadHash: envelope.payloadHash, contentHash: envelope.contentHash })
}
