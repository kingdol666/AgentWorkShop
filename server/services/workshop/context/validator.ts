import { dimensionOf, unitsCompatible } from '@/shared/dimensions'
import {
  attributeSchema,
  contextRelationSchema,
  contextSnapshotSchema,
  contextSubjectSchema,
  domainObjectSchema,
  evidenceEnvelopeSchema,
  learningCandidateSchema,
  materialAssignmentSchema,
  researchCaseSchema,
  researchRunSchema,
  type ContextRef,
  type ContextScope,
  type ContextSnapshot,
  type EvidenceEnvelope,
  type ProvenanceRef,
} from '@/shared/context/contracts'
import { canonicalHash } from '@/shared/context/hash'
import { contextRefSchema, contextScopeSchema, refKey, type ContextWindow } from '@/shared/context/refs'
import { CONTEXT_ERROR_CODES, firstContextError, type ContextIssue } from './errors'

function issue(code: ContextIssue['code'], path: string, message: string): ContextIssue {
  return { code, path, message }
}

function validateWindow(window: ContextWindow | undefined, path: string, issues: ContextIssue[]): void {
  if (!window) return
  if (Date.parse(window.from) > Date.parse(window.to)) {
    issues.push(issue(CONTEXT_ERROR_CODES.INVALID_WINDOW, path, 'window.from must not be later than window.to'))
  }
}

function validateProvenance(provenance: readonly ProvenanceRef[], path: string, issues: ContextIssue[]): void {
  if (provenance.length === 0) {
    issues.push(issue(CONTEXT_ERROR_CODES.INVALID_PROVENANCE, path, 'at least one provenance reference is required'))
    return
  }
  for (const [index, ref] of provenance.entries()) {
    if (ref.redaction && ref.redaction.status !== 'none' && !ref.redaction.policyRef && !ref.redaction.reason) {
      issues.push(issue(CONTEXT_ERROR_CODES.INVALID_REDACTION, `${path}.${index}.redaction`, 'redacted provenance requires policyRef or reason'))
    }
    if (ref.redaction?.status === 'none' && ref.redaction.fields.length) {
      issues.push(issue(CONTEXT_ERROR_CODES.INVALID_REDACTION, `${path}.${index}.redaction.fields`, 'redaction fields require partial or full status'))
    }
  }
}

function validateScope(scope: ContextScope, path: string, issues: ContextIssue[]): void {
  const result = contextScopeSchema.safeParse(scope)
  if (!result.success) issues.push(...result.error.issues.map(item => issue(CONTEXT_ERROR_CODES.INVALID_SCOPE, `${path}.${item.path.join('.')}`, item.message)))
  validateWindow(scope.timeWindow, `${path}.timeWindow`, issues)
}

function validateRefSet(refs: readonly ContextRef[], path: string, issues: ContextIssue[]): void {
  const seen = new Set<string>()
  for (const [index, ref] of refs.entries()) {
    if (!contextRefSchema.safeParse(ref).success) {
      issues.push(issue(CONTEXT_ERROR_CODES.INVALID_REF, `${path}.${index}`, 'invalid context reference'))
      continue
    }
    const key = refKey(ref)
    if (seen.has(key)) issues.push(issue(CONTEXT_ERROR_CODES.DUPLICATE_REF, `${path}.${index}`, `duplicate context reference ${key}`))
    seen.add(key)
  }
}

function parse<T>(schema: { safeParse(value: unknown): { success: true, data: T } | { success: false, error: { issues: Array<{ path: (string | number)[], message: string }> } } }, value: unknown, name: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues.map(item => issue(CONTEXT_ERROR_CODES.INVALID_CONTRACT, item.path.join('.') || '$', item.message))
    throw firstContextError(issues.length ? issues : [issue(CONTEXT_ERROR_CODES.INVALID_CONTRACT, '$', `${name} is invalid`)])
  }
  return result.data
}

export function parseContextSubject(value: unknown) {
  const subject = parse(contextSubjectSchema, value, 'ContextSubject')
  const issues: ContextIssue[] = []
  validateScope(subject.scope, 'scope', issues)
  validateRefSet(subject.parentRefs ?? [], 'parentRefs', issues)
  validateProvenance(subject.provenance, 'provenance', issues)
  if (issues.length) throw firstContextError(issues)
  return subject
}

export function parseDomainObject(value: unknown) {
  const object = parse(domainObjectSchema, value, 'DomainObject')
  const issues: ContextIssue[] = []
  validateRefSet(object.subjectRefs, 'subjectRefs', issues)
  validateRefSet(object.attributes, 'attributes', issues)
  validateProvenance(object.provenance, 'provenance', issues)
  if (issues.length) throw firstContextError(issues)
  return object
}

export function parseAttribute(value: unknown) {
  const attribute = parse(attributeSchema, value, 'Attribute')
  const issues: ContextIssue[] = []
  validateWindow(attribute.validFrom && attribute.validTo ? { from: attribute.validFrom, to: attribute.validTo } : undefined, 'validity', issues)
  validateProvenance(attribute.provenance, 'provenance', issues)
  if (attribute.unit && attribute.constraints) {
    for (const [index, constraint] of attribute.constraints.entries()) {
      if (constraint.unit && !unitsCompatible(attribute.unit, constraint.unit)) {
        issues.push(issue(CONTEXT_ERROR_CODES.INVALID_CONTRACT, `constraints.${index}.unit`, `unit ${constraint.unit} is incompatible with ${attribute.unit} (${dimensionOf(attribute.unit)} vs ${dimensionOf(constraint.unit)})`))
      }
    }
  }
  if (issues.length) throw firstContextError(issues)
  return attribute
}

export function parseMaterialAssignment(value: unknown) {
  const assignment = parse(materialAssignmentSchema, value, 'MaterialAssignment')
  const issues: ContextIssue[] = []
  validateWindow(assignment.validFrom && assignment.validTo ? { from: assignment.validFrom, to: assignment.validTo } : undefined, 'validity', issues)
  validateRefSet(assignment.targetRefs, 'targetRefs', issues)
  validateProvenance(assignment.provenance, 'provenance', issues)
  if (issues.length) throw firstContextError(issues)
  return assignment
}

export function validateSnapshot(snapshot: ContextSnapshot): ContextIssue[] {
  const issues: ContextIssue[] = []
  const parsed = contextSnapshotSchema.safeParse(snapshot)
  if (!parsed.success) return parsed.error.issues.map(item => issue(CONTEXT_ERROR_CODES.INVALID_CONTRACT, item.path.join('.') || '$', item.message))

  validateScope(snapshot.scope, 'scope', issues)
  validateRefSet(snapshot.scope.subjectRefs ?? [], 'scope.subjectRefs', issues)
  validateRefSet(snapshot.scope.objectRefs ?? [], 'scope.objectRefs', issues)
  validateProvenance(snapshot.subjects.flatMap(item => item.provenance), 'subjects.provenance', issues)
  validateProvenance(snapshot.objects.flatMap(item => item.provenance), 'objects.provenance', issues)
  validateProvenance(snapshot.attributes.flatMap(item => item.provenance), 'attributes.provenance', issues)
  validateProvenance(snapshot.materialAssignments.flatMap(item => item.provenance), 'materialAssignments.provenance', issues)

  const known = new Set<string>([
    ...snapshot.subjects.map(item => refKey(item.ref)),
    ...snapshot.objects.map(item => refKey(item.ref)),
    ...snapshot.attributes.map(item => refKey(item.ref)),
    ...snapshot.materialAssignments.map(item => refKey(item.ref)),
  ])
  const checkKnown = (ref: ContextRef, path: string, allowEvidence = false) => {
    if (!known.has(refKey(ref)) && !allowEvidence) issues.push(issue(CONTEXT_ERROR_CODES.DANGLING_REF, path, `reference ${refKey(ref)} is not present in snapshot`))
  }
  for (const [index, object] of snapshot.objects.entries()) {
    object.subjectRefs.forEach((ref, refIndex) => checkKnown(ref, `objects.${index}.subjectRefs.${refIndex}`))
    object.attributes.forEach((ref, refIndex) => checkKnown(ref, `objects.${index}.attributes.${refIndex}`))
  }
  for (const [index, attribute] of snapshot.attributes.entries()) checkKnown(attribute.ownerRef, `attributes.${index}.ownerRef`)
  for (const [index, assignment] of snapshot.materialAssignments.entries()) {
    checkKnown(assignment.materialRef, `materialAssignments.${index}.materialRef`)
    assignment.targetRefs.forEach((ref, refIndex) => checkKnown(ref, `materialAssignments.${index}.targetRefs.${refIndex}`))
  }
  const assignmentKeys = new Set<string>()
  for (const [index, assignment] of snapshot.materialAssignments.entries()) {
    const key = `${refKey(assignment.materialRef)}|${assignment.targetRefs.map(refKey).sort().join(',')}|${assignment.assignmentRole}|${assignment.validFrom ?? ''}|${assignment.validTo ?? ''}`
    if (assignmentKeys.has(key)) issues.push(issue(CONTEXT_ERROR_CODES.DUPLICATE_ASSIGNMENT, `materialAssignments.${index}`, `duplicate material assignment ${key}`))
    assignmentKeys.add(key)
  }
  for (const [index, relation] of snapshot.relations.entries()) {
    checkKnown(relation.src, `relations.${index}.src`)
    checkKnown(relation.dst, `relations.${index}.dst`)
    relation.attributes?.forEach((ref, refIndex) => checkKnown(ref, `relations.${index}.attributes.${refIndex}`))
    validateWindow(relation.validFrom && relation.validTo ? { from: relation.validFrom, to: relation.validTo } : undefined, `relations.${index}.validity`, issues)
  }
  const canonical = snapshotForHash(snapshot)
  if (canonicalHash(canonical) !== snapshot.contentHash) issues.push(issue(CONTEXT_ERROR_CODES.HASH_MISMATCH, 'contentHash', 'contentHash does not match the canonical snapshot content'))
  return issues
}

export function snapshotForHash(snapshot: ContextSnapshot): Omit<ContextSnapshot, 'contentHash'> {
  const { contentHash: _contentHash, ...content } = snapshot
  return content
}

export function canonicalSnapshotHash(snapshot: Omit<ContextSnapshot, 'contentHash'>): string {
  return canonicalHash(snapshot)
}

export function parseContextSnapshot(value: unknown): ContextSnapshot {
  const snapshot = parse(contextSnapshotSchema, value, 'ContextSnapshot')
  const issues = validateSnapshot(snapshot)
  if (issues.length) throw firstContextError(issues)
  return snapshot
}

export function parseContextRelation(value: unknown) {
  return parse(contextRelationSchema, value, 'ContextRelation')
}

export function parseResearchCase(value: unknown) {
  return parse(researchCaseSchema, value, 'ResearchCase')
}

export function parseResearchRun(value: unknown) {
  return parse(researchRunSchema, value, 'ResearchRun')
}

export function parseEvidenceEnvelope(value: unknown) {
  return parse(evidenceEnvelopeSchema, value, 'EvidenceEnvelope')
}

export function parseLearningCandidate(value: unknown) {
  return parse(learningCandidateSchema, value, 'LearningCandidate')
}

export function assertValidSnapshot(snapshot: ContextSnapshot): void {
  const issues = validateSnapshot(snapshot)
  if (issues.length) throw firstContextError(issues)
}

export function validateEvidenceEnvelope(envelope: EvidenceEnvelope): ContextIssue[] {
  const issues: ContextIssue[] = []
  const parsed = evidenceEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) return parsed.error.issues.map(item => issue(CONTEXT_ERROR_CODES.INVALID_CONTRACT, item.path.join('.') || '$', item.message))
  validateScope(envelope.accessScope, 'accessScope', issues)
  validateWindow(envelope.window, 'window', issues)
  if (envelope.quality === 'stale' && envelope.claimLevel === 'validated') issues.push(issue(CONTEXT_ERROR_CODES.INVALID_CLAIM_LEVEL, 'claimLevel', 'stale evidence cannot claim validated'))
  if (envelope.quality === 'rejected' && envelope.claimLevel !== 'anecdotal') issues.push(issue(CONTEXT_ERROR_CODES.INVALID_QUALITY, 'claimLevel', 'rejected evidence must be anecdotal'))
  if (envelope.claimLevel === 'validated' && (!envelope.verifierRefs || envelope.verifierRefs.length === 0)) issues.push(issue(CONTEXT_ERROR_CODES.INVALID_CLAIM_LEVEL, 'verifierRefs', 'validated evidence requires an independent verifier reference'))
  return issues
}
