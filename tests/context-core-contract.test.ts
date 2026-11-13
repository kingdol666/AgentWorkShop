import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalSnapshotHash,
  parseAttribute,
  parseContextSnapshot,
  parseContextSubject,
  parseDomainObject,
  parseEvidenceEnvelope,
  parseMaterialAssignment,
  validateEvidenceEnvelope,
  type ContextSnapshot,
} from '../server/services/workshop/context/validator'
import { CONTEXT_ERROR_CODES, ContextValidationError } from '../server/services/workshop/context/errors'
import { canonicalHash } from '../shared/context/hash'

const at = '2026-01-01T00:00:00.000Z'
const later = '2026-01-02T00:00:00.000Z'
const ref = (namespace: string, id: string) => ({ namespace, id })
const provenance = [{ adapterId: 'fixture.adapter', sourceRef: 'record-1', contentHash: 'a'.repeat(64) }]

function baseSnapshot(): Omit<ContextSnapshot, 'contentHash'> {
  const subjectRef = ref('case', 'subject-1')
  const objectRef = ref('case', 'object-1')
  const attributeRef = ref('case', 'attribute-1')
  const materialRef = ref('case', 'material-1')
  const assignmentRef = ref('case', 'assignment-1')
  return {
    id: 'snapshot-1',
    scope: { subjectRefs: [subjectRef], timeWindow: { from: at, to: later } },
    subjects: [{ ref: subjectRef, subjectType: 'service.case', label: 'Case', scope: {}, status: 'active', provenance }],
    objects: [
      { ref: objectRef, objectType: 'service.object', subjectRefs: [subjectRef], attributes: [attributeRef], provenance },
      { ref: materialRef, objectType: 'service.resource', subjectRefs: [subjectRef], attributes: [], provenance },
    ],
    attributes: [{ ref: attributeRef, ownerRef: objectRef, key: 'service.score', value: 0.8, valueKind: 'scalar', accessMode: 'observe', quality: 'raw', provenance }],
    materialAssignments: [{ ref: assignmentRef, materialRef, targetRefs: [subjectRef], assignmentRole: 'input', status: 'active', validFrom: at, validTo: later, provenance }],
    relations: [{ id: 'relation-1', kind: 'supports', src: objectRef, dst: subjectRef, evidenceRefs: [] }],
    schemaRefs: [{ extensionId: 'service.core', version: '1.0.0' }],
    adapterRefs: [{ adapterId: 'fixture.adapter', version: '1.0.0' }],
    createdAt: at,
  }
}

test('core contracts parse domain-neutral subjects, objects, attributes, and assignments', () => {
  const subjectRef = ref('case', 'subject-1')
  const objectRef = ref('case', 'object-1')
  assert.equal(parseContextSubject({ ref: subjectRef, subjectType: 'customer.case', label: 'Case', scope: {}, status: 'active', provenance }).ref.id, 'subject-1')
  assert.equal(parseDomainObject({ ref: objectRef, objectType: 'customer.request', subjectRefs: [subjectRef], attributes: [], provenance }).objectType, 'customer.request')
  assert.equal(parseAttribute({ ref: ref('case', 'attribute-1'), ownerRef: objectRef, key: 'customer.priority', value: 'high', valueKind: 'scalar', accessMode: 'observe', quality: 'normalized', provenance }).value, 'high')
  assert.equal(parseMaterialAssignment({ ref: ref('case', 'assignment-1'), materialRef: ref('case', 'resource-1'), targetRefs: [subjectRef], assignmentRole: 'resource', status: 'planned', provenance }).status, 'planned')
})

test('canonical snapshot hash is stable across object key order', () => {
  const content = baseSnapshot()
  const first = canonicalSnapshotHash(content)
  const second = canonicalHash(JSON.parse(JSON.stringify({ ...content, scope: { timeWindow: content.scope.timeWindow, subjectRefs: content.scope.subjectRefs }, id: content.id })))
  assert.equal(first, second)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.deepEqual(parseContextSnapshot({ ...content, contentHash: first }).contentHash, first)
})

test('snapshot rejects dangling refs, invalid windows, duplicate assignments, and hash drift', () => {
  const content = baseSnapshot()
  const bad = {
    ...content,
    contentHash: 'b'.repeat(64),
    objects: [{ ...content.objects[0]!, subjectRefs: [ref('missing', 'subject')] }],
    materialAssignments: [content.materialAssignments[0]!, { ...content.materialAssignments[0]!, ref: ref('case', 'assignment-2') }],
    relations: [{ ...content.relations[0]!, validFrom: later, validTo: at }],
  }
  assert.throws(() => parseContextSnapshot(bad), (error: unknown) => {
    assert.ok(error instanceof ContextValidationError)
    const codes = error.issues.map(item => item.code)
    assert.ok(codes.includes(CONTEXT_ERROR_CODES.DANGLING_REF))
    assert.ok(codes.includes(CONTEXT_ERROR_CODES.DUPLICATE_ASSIGNMENT))
    assert.ok(codes.includes(CONTEXT_ERROR_CODES.INVALID_WINDOW))
    assert.ok(codes.includes(CONTEXT_ERROR_CODES.HASH_MISMATCH))
    return true
  })
})

test('provenance and redaction validation is fail-closed', () => {
  assert.throws(() => parseContextSubject({ ref: ref('case', 'subject-1'), subjectType: 'case', label: 'Case', scope: {}, status: 'active', provenance: [] }), ContextValidationError)
  assert.throws(() => parseContextSubject({ ref: ref('case', 'subject-1'), subjectType: 'case', label: 'Case', scope: {}, status: 'active', provenance: [{ adapterId: 'adapter', sourceRef: 'source', redaction: { status: 'partial', fields: ['secret'] } }] }), (error: unknown) => {
    assert.ok(error instanceof ContextValidationError)
    assert.equal(error.code, CONTEXT_ERROR_CODES.INVALID_REDACTION)
    return true
  })
})

test('evidence quality and claim levels cannot overstate stale or rejected evidence', () => {
  const envelope = {
    id: 'evidence-1', kind: 'observation', subjectRefs: [ref('case', 'subject-1')], source: { adapterId: 'adapter', sourceRef: 'record' },
    payloadRef: 'blob://record', payloadHash: 'c'.repeat(64), quality: 'stale', claimLevel: 'validated', accessScope: {}, createdAt: at,
  } as const
  const issues = validateEvidenceEnvelope(envelope)
  assert.ok(issues.some(item => item.code === CONTEXT_ERROR_CODES.INVALID_CLAIM_LEVEL))
  assert.equal(parseEvidenceEnvelope({ ...envelope, claimLevel: 'observed' }).id, 'evidence-1')
})
