import { z } from 'zod'
import {
  contextRefSchema,
  contextScopeSchema,
  contextWindowSchema,
  isoTimestampSchema,
  provenanceRefSchema,
  redactionSchema,
} from './refs'

export const CONTEXT_CONTRACT_VERSION = 'context.v1' as const

export const SUBJECT_STATUSES = ['draft', 'active', 'suspended', 'retired'] as const
export const ATTRIBUTE_VALUE_KINDS = ['scalar', 'vector', 'table', 'file', 'event', 'reference'] as const
export const ATTRIBUTE_ACCESS_MODES = ['observe', 'set', 'derive'] as const
export const ATTRIBUTE_QUALITY = ['raw', 'normalized', 'derived', 'verified', 'rejected'] as const
export const MATERIAL_ASSIGNMENT_STATUSES = ['planned', 'active', 'consumed', 'released', 'recalled'] as const
export const EVIDENCE_KINDS = ['observation', 'intervention', 'simulation', 'replay', 'document', 'human-review', 'model-output', 'verification'] as const
export const EVIDENCE_QUALITY = ['raw', 'normalized', 'verified', 'rejected', 'stale'] as const
export const CLAIM_LEVELS = ['candidate', 'observed', 'supported', 'validated', 'anecdotal'] as const
export const RESEARCH_CASE_STATUSES = ['draft', 'planned', 'approved', 'running', 'paused', 'completed', 'failed', 'retired'] as const
export const RESEARCH_RUN_STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped'] as const

const nonEmptyKey = z.string().trim().min(1).max(240)
const extensionDataSchema = z.record(z.string(), z.unknown())
const contextRefListSchema = z.array(contextRefSchema)

export const quantitySchema = z.object({
  value: z.number().finite(),
  unit: z.string().trim().min(1).max(64),
})
export type Quantity = z.infer<typeof quantitySchema>

export const attributeConstraintSchema = z.object({
  kind: z.string().trim().min(1).max(120),
  value: z.unknown(),
  unit: z.string().trim().min(1).max(64).optional(),
})
export type AttributeConstraint = z.infer<typeof attributeConstraintSchema>

export const contextSubjectSchema = z.object({
  ref: contextRefSchema,
  subjectType: nonEmptyKey,
  label: z.string().trim().min(1).max(240),
  scope: contextScopeSchema,
  parentRefs: contextRefListSchema.optional(),
  status: z.enum(SUBJECT_STATUSES),
  extensionData: extensionDataSchema.optional(),
  provenance: z.array(provenanceRefSchema).min(1),
})
export type ContextSubject = z.infer<typeof contextSubjectSchema>

export const domainObjectSchema = z.object({
  ref: contextRefSchema,
  objectType: nonEmptyKey,
  subjectRefs: contextRefListSchema.min(1),
  role: nonEmptyKey.optional(),
  attributes: contextRefListSchema,
  extensionData: extensionDataSchema.optional(),
  provenance: z.array(provenanceRefSchema).min(1),
})
export type DomainObject = z.infer<typeof domainObjectSchema>

const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const fileRefSchema = z.object({
  ref: contextRefSchema.optional(),
  uri: z.string().trim().min(1).max(1000).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).refine(value => Boolean(value.ref || value.uri), 'file value requires ref or uri')
const eventValueSchema = z.object({
  type: z.string().trim().min(1).max(120),
  data: z.unknown(),
})
const tableSchema = z.array(z.record(z.string(), z.unknown()))
const attributeValueSchema = z.union([
  scalarSchema,
  z.array(scalarSchema),
  tableSchema,
  fileRefSchema,
  eventValueSchema,
  z.array(contextRefSchema).min(1),
])

export const attributeSchema = z.object({
  ref: contextRefSchema,
  ownerRef: contextRefSchema,
  key: z.string().trim().min(1).max(240).regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/, 'attribute key must be namespace-qualified'),
  value: attributeValueSchema,
  valueKind: z.enum(ATTRIBUTE_VALUE_KINDS),
  unit: z.string().trim().min(1).max(64).optional(),
  semanticType: nonEmptyKey.optional(),
  accessMode: z.enum(ATTRIBUTE_ACCESS_MODES),
  validFrom: isoTimestampSchema.optional(),
  validTo: isoTimestampSchema.optional(),
  quality: z.enum(ATTRIBUTE_QUALITY),
  provenance: z.array(provenanceRefSchema).min(1),
  constraints: z.array(attributeConstraintSchema).optional(),
})
export type Attribute = z.infer<typeof attributeSchema>

export const materialAssignmentSchema = z.object({
  ref: contextRefSchema,
  materialRef: contextRefSchema,
  targetRefs: contextRefListSchema.min(1),
  assignmentRole: nonEmptyKey,
  quantity: quantitySchema.optional(),
  validFrom: isoTimestampSchema.optional(),
  validTo: isoTimestampSchema.optional(),
  status: z.enum(MATERIAL_ASSIGNMENT_STATUSES),
  provenance: z.array(provenanceRefSchema).min(1),
  extensionData: extensionDataSchema.optional(),
})
export type MaterialAssignment = z.infer<typeof materialAssignmentSchema>

export const contextRelationSchema = z.object({
  id: nonEmptyKey,
  kind: nonEmptyKey,
  src: contextRefSchema,
  dst: contextRefSchema,
  attributes: contextRefListSchema.optional(),
  evidenceRefs: contextRefListSchema,
  validFrom: isoTimestampSchema.optional(),
  validTo: isoTimestampSchema.optional(),
})
export type ContextRelation = z.infer<typeof contextRelationSchema>

export const extensionRefSchema = z.object({
  extensionId: nonEmptyKey,
  version: nonEmptyKey,
})
export type ExtensionRef = z.infer<typeof extensionRefSchema>

export const adapterRefSchema = z.object({
  adapterId: nonEmptyKey,
  version: nonEmptyKey,
})
export type AdapterRef = z.infer<typeof adapterRefSchema>

export const contextSnapshotSchema = z.object({
  id: nonEmptyKey,
  scope: contextScopeSchema,
  subjects: z.array(contextSubjectSchema),
  objects: z.array(domainObjectSchema),
  attributes: z.array(attributeSchema),
  materialAssignments: z.array(materialAssignmentSchema),
  relations: z.array(contextRelationSchema),
  schemaRefs: z.array(extensionRefSchema),
  adapterRefs: z.array(adapterRefSchema),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  createdAt: isoTimestampSchema,
})
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>

export const researchCaseSchema = z.object({
  id: nonEmptyKey,
  objective: z.string().trim().min(1).max(5000),
  question: z.string().trim().min(1).max(5000),
  scope: contextScopeSchema,
  contextSnapshotId: nonEmptyKey,
  hypothesisRefs: z.array(contextRefSchema),
  allowedCapabilities: z.array(nonEmptyKey),
  evidencePolicyRef: nonEmptyKey,
  acceptanceProfileRef: nonEmptyKey.optional(),
  status: z.enum(RESEARCH_CASE_STATUSES),
})
export type ResearchCase = z.infer<typeof researchCaseSchema>

export const researchRunSchema = z.object({
  id: nonEmptyKey,
  caseId: nonEmptyKey,
  status: z.enum(RESEARCH_RUN_STATUSES),
  startedAt: isoTimestampSchema.optional(),
  endedAt: isoTimestampSchema.optional(),
  contextSnapshotId: nonEmptyKey,
  evidenceRefs: z.array(contextRefSchema),
  resultRef: contextRefSchema.optional(),
  errorCode: nonEmptyKey.optional(),
})
export type ResearchRun = z.infer<typeof researchRunSchema>

export const evidenceSourceSchema = z.object({
  adapterId: nonEmptyKey,
  sourceRef: z.string().trim().min(1).max(500),
  sourceRevision: z.string().trim().min(1).max(120).optional(),
})

export const evidenceEnvelopeSchema = z.object({
  id: nonEmptyKey,
  kind: z.enum(EVIDENCE_KINDS),
  subjectRefs: contextRefListSchema.min(1),
  objectRefs: contextRefListSchema.optional(),
  attributeRefs: contextRefListSchema.optional(),
  materialAssignmentRefs: contextRefListSchema.optional(),
  researchCaseId: nonEmptyKey.optional(),
  researchRunId: nonEmptyKey.optional(),
  window: contextWindowSchema.optional(),
  source: evidenceSourceSchema,
  payloadRef: z.string().trim().min(1).max(1000),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  quality: z.enum(EVIDENCE_QUALITY),
  claimLevel: z.enum(CLAIM_LEVELS),
  supports: z.array(nonEmptyKey).optional(),
  refutes: z.array(nonEmptyKey).optional(),
  verifierRefs: contextRefListSchema.optional(),
  accessScope: contextScopeSchema,
  redaction: redactionSchema.optional(),
  createdAt: isoTimestampSchema,
})
export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>

export const learningCandidateSchema = z.object({
  id: nonEmptyKey,
  claim: z.string().trim().min(1).max(5000),
  evidenceRefs: contextRefListSchema.min(1),
  scope: contextScopeSchema,
  claimLevel: z.enum(CLAIM_LEVELS),
  status: z.enum(['candidate', 'validated', 'promoted', 'rejected', 'retired']),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  createdAt: isoTimestampSchema,
})
export type LearningCandidate = z.infer<typeof learningCandidateSchema>

export type ContextContract
  = | ContextSubject
    | DomainObject
    | Attribute
    | MaterialAssignment
    | ContextRelation
    | ContextSnapshot
    | ResearchCase
    | ResearchRun
    | EvidenceEnvelope
    | LearningCandidate

export {
  contextRefSchema,
  contextScopeSchema,
  contextWindowSchema,
  isoTimestampSchema,
  provenanceRefSchema,
  redactionSchema,
}

export type { ContextRef, ContextScope, ContextWindow, IsoTimestamp, ProvenanceRef, Redaction } from './refs'
