import type {
  Attribute,
  ContextRef,
  ContextScope,
  ContextSnapshot,
  ContextSubject,
  DomainObject,
  MaterialAssignment,
  ProvenanceRef,
} from '@/shared/context/contracts'
import { canonicalSnapshotHash } from './validator'

export const CONTEXT_PROJECTION_VERSION = 'context-projection.v1' as const
export const CONTEXT_PROJECTION_ADAPTER_API_VERSION = 'context-adapter.v1' as const

export type ProjectionSource = {
  adapterId: string
  version: string
  sourceRef: string
  sourceRevision?: string
  capturedAt?: string
  contentHash?: string
}

export type ProjectionWindow = {
  from: string
  to: string
}

export type ProjectionInput = {
  id: string
  scope?: ContextScope
  window?: ProjectionWindow
  source: ProjectionSource
  schemaRefs?: Array<{ extensionId: string, version: string }>
  subjects?: readonly ContextSubject[]
  objects?: readonly DomainObject[]
  attributes?: readonly Attribute[]
  materialAssignments?: readonly MaterialAssignment[]
  relations?: ContextSnapshot['relations']
}

export type ProjectionResult = ContextSnapshot & {
  projection: {
    adapterId: string
    adapterVersion: string
    projectionVersion: typeof CONTEXT_PROJECTION_VERSION
    sourceRef: string
    sourceRevision?: string
    window?: ProjectionWindow
  }
}

export function contextRef(namespace: string, id: string, revision?: string): ContextRef {
  return { namespace, id, ...(revision ? { revision } : {}) }
}

function provenanceOf(source: ProjectionSource): ProvenanceRef {
  return {
    adapterId: source.adapterId,
    sourceRef: source.sourceRef,
    ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}),
    ...(source.contentHash ? { contentHash: source.contentHash } : {}),
  }
}

function mergeScope(scope: ContextScope | undefined, window: ProjectionWindow | undefined): ContextScope {
  return {
    ...(scope ?? {}),
    ...(window ? { timeWindow: window } : {}),
  }
}

function addProvenance<T extends { provenance: ProvenanceRef[] }>(value: T, provenance: ProvenanceRef): T {
  const existing = value.provenance.some(item => item.adapterId === provenance.adapterId && item.sourceRef === provenance.sourceRef && item.sourceRevision === provenance.sourceRevision)
  return {
    ...value,
    provenance: existing ? value.provenance : [...value.provenance, provenance],
  }
}

function validateUniqueRefs(snapshot: Pick<ContextSnapshot, 'subjects' | 'objects' | 'attributes' | 'materialAssignments'>): void {
  const seen = new Set<string>()
  for (const ref of [
    ...snapshot.subjects.map(item => item.ref),
    ...snapshot.objects.map(item => item.ref),
    ...snapshot.attributes.map(item => item.ref),
    ...snapshot.materialAssignments.map(item => item.ref),
  ]) {
    const key = `${ref.namespace}:${ref.id}:${ref.revision ?? ''}`
    if (seen.has(key)) throw new Error(`duplicate projected context reference ${key}`)
    seen.add(key)
  }
}

/**
 * Build a canonical, read-only context projection from adapter-owned records.
 * The mapper does not perform persistence or call any control/orchestration path.
 */
export function projectContext(input: ProjectionInput): ProjectionResult {
  const capturedAt = input.source.capturedAt ?? new Date().toISOString()
  const provenance = provenanceOf({ ...input.source, capturedAt })
  const scope = mergeScope(input.scope, input.window)
  const subjects = (input.subjects ?? []).map(item => addProvenance(item, provenance))
  const objects: Array<DomainObject> = (input.objects ?? []).map(item => addProvenance({
    ref: item.ref,
    objectType: item.objectType,
    subjectRefs: item.subjectRefs,
    ...(item.role ? { role: item.role } : {}),
    attributes: [...item.attributes],
    ...(item.extensionData ? { extensionData: item.extensionData } : {}),
    provenance: item.provenance,
  }, provenance))
  const attributes: Array<Attribute> = (input.attributes ?? []).map(item => addProvenance({ ...item, provenance: [...item.provenance] }, provenance))
  const materialAssignments: Array<MaterialAssignment> = (input.materialAssignments ?? []).map(item => addProvenance({ ...item, provenance: [...item.provenance] }, provenance))
  const content: Omit<ContextSnapshot, 'contentHash'> = {
    id: input.id,
    scope,
    subjects,
    objects,
    attributes,
    materialAssignments,
    relations: input.relations ? [...input.relations] : [],
    schemaRefs: input.schemaRefs ? [...input.schemaRefs] : [],
    adapterRefs: [{ adapterId: input.source.adapterId, version: input.source.version }],
    createdAt: capturedAt,
  }
  validateUniqueRefs(content)
  const snapshot: ContextSnapshot = { ...content, contentHash: canonicalSnapshotHash(content) }
  return {
    ...snapshot,
    projection: {
      adapterId: input.source.adapterId,
      adapterVersion: input.source.version,
      projectionVersion: CONTEXT_PROJECTION_VERSION,
      sourceRef: input.source.sourceRef,
      ...(input.source.sourceRevision ? { sourceRevision: input.source.sourceRevision } : {}),
      ...(input.window ? { window: input.window } : {}),
    },
  }
}

export function projectGenericFixture(input: {
  id: string
  subject: { id: string, type: string, label: string, status?: ContextSubject['status'], extensionData?: Record<string, unknown> }
  objects?: Array<{ id: string, type: string, label?: string, role?: string, extensionData?: Record<string, unknown> }>
  attributes?: Array<{ id: string, ownerId: string, key: string, value: Attribute['value'], valueKind: Attribute['valueKind'], unit?: string, semanticType?: string, accessMode?: Attribute['accessMode'], quality?: Attribute['quality'], validFrom?: string, validTo?: string }>
  materials?: Array<{ id: string, label?: string, role?: string, quantity?: { value: number, unit: string }, status?: MaterialAssignment['status'], validFrom?: string, validTo?: string }>
  source: ProjectionSource
  scope?: ContextScope
  window?: ProjectionWindow
}): ProjectionResult {
  const subjectRef = contextRef('fixture.subject', input.subject.id)
  const objectRefById = new Map<string, ContextRef>()
  const objects: Array<DomainObject> = (input.objects ?? []).map((item) => {
    const ref = contextRef('fixture.object', item.id)
    objectRefById.set(item.id, ref)
    return { ref, objectType: item.type, subjectRefs: [subjectRef], ...(item.role ? { role: item.role } : {}), attributes: [], ...(item.label || item.extensionData ? { extensionData: { ...(item.label ? { label: item.label } : {}), ...(item.extensionData ?? {}) } } : {}), provenance: [] }
  })
  const attributes = (input.attributes ?? []).map((item) => {
    const ownerRef = objectRefById.get(item.ownerId) ?? subjectRef
    const ref = contextRef('fixture.attribute', item.id)
    const attribute: Attribute = {
      ref,
      ownerRef,
      key: item.key,
      value: item.value,
      valueKind: item.valueKind,
      ...(item.unit ? { unit: item.unit } : {}),
      ...(item.semanticType ? { semanticType: item.semanticType } : {}),
      accessMode: item.accessMode ?? 'observe',
      ...(item.validFrom ? { validFrom: item.validFrom } : {}),
      ...(item.validTo ? { validTo: item.validTo } : {}),
      quality: item.quality ?? 'raw',
      provenance: [],
    }
    const owner = objects.find(object => object.ref.id === ownerRef.id)
    if (owner) (owner.attributes as ContextRef[]).push(ref)
    return attribute
  })
  const materialObjects = (input.materials ?? []).map((item) => {
    const materialRef = contextRef('fixture.material', item.id)
    objects.push({ ref: materialRef, objectType: 'fixture.material', subjectRefs: [subjectRef], role: item.role ?? 'material', attributes: [], extensionData: { ...(item.label ? { label: item.label } : {}) }, provenance: [] })
    return {
      ref: contextRef('fixture.assignment', item.id),
      materialRef,
      targetRefs: [subjectRef],
      assignmentRole: item.role ?? 'input',
      ...(item.quantity ? { quantity: item.quantity } : {}),
      ...(item.validFrom ? { validFrom: item.validFrom } : {}),
      ...(item.validTo ? { validTo: item.validTo } : {}),
      status: item.status ?? 'active',
      provenance: [],
    } satisfies MaterialAssignment
  })
  return projectContext({
    id: input.id,
    scope: input.scope,
    window: input.window,
    source: input.source,
    subjects: [{ ref: subjectRef, subjectType: input.subject.type, label: input.subject.label, scope: input.scope ?? {}, status: input.subject.status ?? 'active', ...(input.subject.extensionData ? { extensionData: input.subject.extensionData } : {}), provenance: [] }],
    objects,
    attributes,
    materialAssignments: materialObjects,
  })
}
