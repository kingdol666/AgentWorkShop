import type {
  Attribute,
  ContextAdapter,
  ContextAdapterOperationRequest,
  ContextAdapterAuthorizer,
  ContextRef,
  ContextSubject,
  DomainObject,
  MaterialAssignment,
} from '../contracts'
import { canonicalHash } from '@/shared/context/hash'
import { getAgentNodeBindingRepo } from '../../agents/node-bindings.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDeviceTwinRepo } from '../../assets/device-twin.repo'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getDcwNodeRepo } from '../../dcw/dcw-node.repo'
import { getDcwProductRepo } from '../../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { MES_REST_DRIVER_KIND, mesCatalogEntryOf } from '../../mes/mes-controller'
import { contextRef, projectContext, type ProjectionResult, type ProjectionSource, type ProjectionWindow } from '../projection'

export const INDUSTRIAL_READ_ADAPTER_ID = 'industrial-read'
export const INDUSTRIAL_READ_ADAPTER_VERSION = '1.0.0'

type ReadRecord = Record<string, unknown>
type ProjectedObject = DomainObject & { attributes: ContextRef[] }
type ProjectedAttribute = Attribute

type ReadServices = {
  lines: { all(): readonly ReadRecord[], byId(id: string): ReadRecord | undefined }
  products: { all(): readonly ReadRecord[], byId(id: string): ReadRecord | undefined }
  recipes: { list(): readonly ReadRecord[], byId(id: string): ReadRecord | undefined, listRuns(): readonly ReadRecord[], runById(id: string): ReadRecord | undefined }
  dcwNodes: { all(): readonly ReadRecord[] }
  daqNodes: { all(): readonly ReadRecord[] }
  bindings: { all(): readonly ReadRecord[] }
  twins: { listAll(): readonly ReadRecord[], findById(id: string): ReadRecord | undefined }
}

export type IndustrialReadRequest = {
  id?: string
  lineId?: string
  scope?: Parameters<typeof projectContext>[0]['scope']
  window?: ProjectionWindow
}

export type IndustrialReadPayload = {
  snapshot: ProjectionResult
  source: {
    adapterId: string
    version: string
    lineId?: string
    counts: Record<string, number>
  }
}

function defaultServices(): ReadServices {
  return {
    lines: getDcwLineRepo() as unknown as ReadServices['lines'],
    products: getDcwProductRepo() as unknown as ReadServices['products'],
    recipes: getDcwRecipeRepo() as unknown as ReadServices['recipes'],
    dcwNodes: getDcwNodeRepo() as unknown as ReadServices['dcwNodes'],
    daqNodes: getDaqNodeRepo() as unknown as ReadServices['daqNodes'],
    bindings: getAgentNodeBindingRepo() as unknown as ReadServices['bindings'],
    twins: getDeviceTwinRepo() as unknown as ReadServices['twins'],
  }
}

function record(value: unknown): ReadRecord {
  return value as ReadRecord
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function sourceRef(lineId?: string): string {
  return `industrial.read:${lineId || 'all'}`
}

function sourceValue(value: unknown): Attribute['value'] {
  if (value === undefined) return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value as Attribute['value']
}

function addAttribute(
  attributes: ProjectedAttribute[],
  ownerRef: ContextRef,
  id: string,
  key: string,
  value: unknown,
  valueKind: 'scalar' | 'vector' | 'table' | 'event' | 'reference' = 'scalar',
  unit?: string,
): ReturnType<typeof contextRef> {
  const ref = contextRef('industrial.attribute', id)
  attributes.push({
    ref,
    ownerRef,
    key,
    value: sourceValue(value),
    valueKind,
    ...(unit ? { unit } : {}),
    accessMode: 'observe',
    quality: 'raw',
    provenance: [],
  })
  return ref
}

function labelOf(item: ReadRecord, fallback: string): string {
  return text(item.name) || text(item.label) || fallback
}

function asView(item: ReadRecord): ReadRecord {
  const toView = item.toView
  return typeof toView === 'function' ? record(toView.call(item)) : { ...item }
}

function selected<T extends ReadRecord>(items: readonly T[], lineId: string | undefined): T[] {
  if (!lineId) return [...items]
  return items.filter(item => text(item.lineId) === lineId)
}

function selectedTwins(services: ReadServices, nodeRecords: readonly ReadRecord[], lineId?: string): ReadRecord[] {
  const ids = new Set<string>()
  for (const node of nodeRecords) {
    const deviceIds = Array.isArray(node.deviceIds) ? node.deviceIds : []
    for (const id of deviceIds) ids.add(text(id))
    if (node.deviceBindingId) ids.add(text(node.deviceBindingId))
  }
  const twins = services.twins.listAll()
  if (!lineId) return ids.size > 0 ? twins.filter(twin => ids.has(text(twin.id))) : [...twins]
  return twins.filter(twin => ids.has(text(twin.id)))
}

function projectIndustrialRead(services: ReadServices, request: IndustrialReadRequest, adapterId: string, version: string, now: string): IndustrialReadPayload {
  const lineId = text(request.lineId) || undefined
  const lines = lineId ? services.lines.all().filter(item => text(item.id) === lineId) : [...services.lines.all()]
  const products = selected(services.products.all(), lineId)
  const recipes = selected(services.recipes.list(), lineId)
  const recipeIds = new Set(recipes.map(item => text(item.id)))
  const runs = selected(services.recipes.listRuns(), lineId).filter(item => !lineId || recipeIds.has(text(item.recipeId)))
  const dcwNodes = selected(services.dcwNodes.all(), lineId).map(asView)
  const daqNodes = selected(services.daqNodes.all(), lineId).map(asView)
  const bindings = [...services.bindings.all()].filter((item) => {
    if (!lineId) return true
    const kind = text(item.kind)
    const nodeId = text(item.nodeId)
    if (kind === 'line-recipe') return nodeId === lineId
    if (kind === 'recipe') return recipeIds.has(nodeId)
    return dcwNodes.some(node => text(node.id) === nodeId) || daqNodes.some(node => text(node.id) === nodeId)
  })
  const twins = selectedTwins(services, [...dcwNodes, ...daqNodes], lineId)
  const lineRefById = new Map<string, ReturnType<typeof contextRef>>()
  const productRefById = new Map<string, ReturnType<typeof contextRef>>()
  const recipeRefById = new Map<string, ReturnType<typeof contextRef>>()
  const runRefById = new Map<string, ReturnType<typeof contextRef>>()
  const nodeRefById = new Map<string, ReturnType<typeof contextRef>>()
  const twinRefById = new Map<string, ReturnType<typeof contextRef>>()
  const bindingRefById = new Map<string, ReturnType<typeof contextRef>>()
  const rootRef = contextRef('industrial.scope', lineId ? `line-${lineId}` : 'global')
  const subjects: ContextSubject[] = [{ ref: rootRef, subjectType: 'industrial.context', label: lineId ? `Industrial context ${lineId}` : 'Industrial context', scope: request.scope ?? {}, status: 'active', provenance: [] }]
  const objects: ProjectedObject[] = []
  const attributes: ProjectedAttribute[] = []
  const materialAssignments: MaterialAssignment[] = []
  const relations: Array<Record<string, unknown>> = []

  for (const line of lines) {
    const id = text(line.id)
    const ref = contextRef('industrial.line', id)
    lineRefById.set(id, ref)
    subjects.push({ ref, subjectType: 'industrial.production-line', label: labelOf(line, id), scope: { ...(request.scope ?? {}), tags: ['industrial', 'line'] }, status: 'active', extensionData: { lineId: id }, provenance: [] })
    addAttribute(attributes, ref, `${id}.description`, 'industrial.line.description', text(line.description))
    addAttribute(attributes, ref, `${id}.control-mode`, 'industrial.line.control-mode', text(line.controlMode) || 'manual')
    addAttribute(attributes, ref, `${id}.simulated`, 'industrial.line.simulated', line.simulated === true)
  }

  const subjectFor = (lineValue: unknown): ReturnType<typeof contextRef> => lineRefById.get(text(lineValue)) ?? rootRef
  for (const product of products) {
    const id = text(product.id)
    const ref = contextRef('industrial.product', id)
    productRefById.set(id, ref)
    const subjectRef = subjectFor(product.lineId)
    const object: ProjectedObject = { ref, objectType: 'industrial.product', subjectRefs: [subjectRef], attributes: [], extensionData: { productId: id, ...(text(product.lineId) ? { lineId: text(product.lineId) } : {}) }, provenance: [] }
    object.attributes.push(addAttribute(attributes, ref, `${id}.description`, 'industrial.product.description', text(product.description)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.limits`, 'industrial.product.parameter-limits', product.paramLimits ?? {}, 'table'))
    objects.push(object)
    if (lineRefById.has(text(product.lineId))) materialAssignments.push({ ref: contextRef('industrial.assignment', `product-${id}`), materialRef: ref, targetRefs: [subjectRef], assignmentRole: 'product', status: 'active', provenance: [] })
    if (lineRefById.has(text(product.lineId))) relations.push({ id: `product-${id}-line`, kind: 'industrial.attached-to', src: ref, dst: subjectRef, evidenceRefs: [] })
  }

  for (const recipe of recipes) {
    const id = text(recipe.id)
    const ref = contextRef('industrial.recipe', id)
    recipeRefById.set(id, ref)
    const subjectRef = subjectFor(recipe.lineId)
    const object: ProjectedObject = { ref, objectType: 'industrial.recipe', subjectRefs: [subjectRef], attributes: [], extensionData: { recipeId: id, productId: text(recipe.productId), ...(text(recipe.lineId) ? { lineId: text(recipe.lineId) } : {}) }, provenance: [] }
    object.attributes.push(addAttribute(attributes, ref, `${id}.description`, 'industrial.recipe.description', text(recipe.description)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.version`, 'industrial.recipe.version', Number(recipe.version ?? 1)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.params`, 'industrial.recipe.parameters', recipe.params ?? [], 'table'))
    object.attributes.push(addAttribute(attributes, ref, `${id}.daq-windows`, 'industrial.recipe.daq-windows', recipe.daqWindows ?? [], 'table'))
    objects.push(object)
    const productRef = productRefById.get(text(recipe.productId))
    if (productRef) relations.push({ id: `recipe-${id}-product`, kind: 'industrial.defined-for', src: ref, dst: productRef, evidenceRefs: [] })
  }

  for (const run of runs) {
    const id = text(run.id)
    const ref = contextRef('industrial.run', id)
    runRefById.set(id, ref)
    const subjectRef = subjectFor(run.lineId)
    const object: ProjectedObject = { ref, objectType: 'industrial.run', subjectRefs: [subjectRef], attributes: [], extensionData: { runId: id, recipeId: text(run.recipeId), productId: text(run.productId), lineId: text(run.lineId) }, provenance: [] }
    object.attributes.push(addAttribute(attributes, ref, `${id}.started-at`, 'industrial.run.started-at', text(run.startedAt)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.ended-at`, 'industrial.run.ended-at', run.endedAt == null ? null : text(run.endedAt)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.recipe-version`, 'industrial.run.recipe-version', Number(run.recipeVersion ?? 0)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.results`, 'industrial.run.results', run.results ?? [], 'table'))
    objects.push(object)
    const recipeRef = recipeRefById.get(text(run.recipeId))
    if (recipeRef) relations.push({ id: `run-${id}-recipe`, kind: 'industrial.instance-of', src: ref, dst: recipeRef, evidenceRefs: [] })
  }

  const addNode = (node: ReadRecord, kind: 'dcw' | 'daq') => {
    const id = text(node.id)
    const ref = contextRef(`industrial.${kind}`, id)
    nodeRefById.set(`${kind}:${id}`, ref)
    const subjectRef = subjectFor(node.lineId)
    const object: ProjectedObject = { ref, objectType: `industrial.${kind}-node`, subjectRefs: [subjectRef], attributes: [], extensionData: { nodeId: id, lineId: text(node.lineId), templateRef: text(node.templateRef), driver: text(node.driver) }, provenance: [] }
    object.attributes.push(addAttribute(attributes, ref, `${kind}.${id}.name`, `industrial.${kind}.name`, labelOf(node, id)))
    object.attributes.push(addAttribute(attributes, ref, `${kind}.${id}.enabled`, `industrial.${kind}.enabled`, node.enabled === true))
    object.attributes.push(addAttribute(attributes, ref, `${kind}.${id}.value`, `industrial.${kind}.value`, node.value ?? (kind === 'dcw' ? node.readValue : null), 'scalar', text(node.unit) || undefined))
    object.attributes.push(addAttribute(attributes, ref, `${kind}.${id}.state`, `industrial.${kind}.state`, text(node.state)))
    object.attributes.push(addAttribute(attributes, ref, `${kind}.${id}.range`, `industrial.${kind}.range`, { min: node.min ?? null, max: node.max ?? null, unit: text(node.unit) }, 'event'))
    if (kind === 'daq' && text(node.driver) === MES_REST_DRIVER_KIND) {
      const mes = mesCatalogEntryOf(node as never)
      object.objectType = 'industrial.mes-point'
      object.extensionData = { ...object.extensionData, mes: { readable: mes.readable, writable: mes.writable, historyable: mes.historyable, format: mes.format, hooked: mes.hooked, fields: mes.fields } }
      object.attributes.push(addAttribute(attributes, ref, `mes.${id}.description`, 'industrial.mes.description', mes.desc))
      object.attributes.push(addAttribute(attributes, ref, `mes.${id}.capabilities`, 'industrial.mes.capabilities', { readable: mes.readable, writable: mes.writable, historyable: mes.historyable, format: mes.format, hooked: mes.hooked }, 'event'))
    }
    objects.push(object)
  }
  dcwNodes.forEach(node => addNode(node, 'dcw'))
  daqNodes.forEach(node => addNode(node, 'daq'))

  for (const twin of twins) {
    const id = text(twin.id)
    const ref = contextRef('industrial.twin', id)
    twinRefById.set(id, ref)
    const object: ProjectedObject = { ref, objectType: 'industrial.device-twin', subjectRefs: [rootRef], attributes: [], extensionData: { twinId: id, kind: text(twin.kind), modelRef: text(twin.modelRef), workspaceId: text(twin.workspaceId) }, provenance: [] }
    object.attributes.push(addAttribute(attributes, ref, `${id}.state`, 'industrial.twin.state', text(twin.state)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.telemetry`, 'industrial.twin.telemetry', twin.telemetry ?? {}, 'event'))
    objects.push(object)
  }

  for (const binding of bindings) {
    const id = text(binding.id)
    const ref = contextRef('industrial.binding', id)
    bindingRefById.set(id, ref)
    const target = recipeRefById.get(text(binding.nodeId)) ?? nodeRefById.get(`dcw:${text(binding.nodeId)}`) ?? nodeRefById.get(`daq:${text(binding.nodeId)}`) ?? lineRefById.get(text(binding.nodeId))
    const subjectRefs = target ? [target] : [rootRef]
    const object: ProjectedObject = { ref, objectType: 'industrial.binding', subjectRefs, attributes: [], extensionData: { bindingId: id, agentId: text(binding.agentId), nodeId: text(binding.nodeId), kind: text(binding.kind), mode: text(binding.mode) }, provenance: [] }
    object.attributes.push(addAttribute(attributes, ref, `${id}.mode`, 'industrial.binding.mode', text(binding.mode)))
    object.attributes.push(addAttribute(attributes, ref, `${id}.tuning`, 'industrial.binding.tuning', binding.tuning ?? {}, 'event'))
    objects.push(object)
    if (target) relations.push({ id: `binding-${id}-target`, kind: 'industrial.authorizes', src: ref, dst: target, evidenceRefs: [] })
  }

  for (const [kind, nodes] of [['dcw', dcwNodes], ['daq', daqNodes] as const]) {
    for (const node of nodes as ReadRecord[]) {
      const nodeRef = nodeRefById.get(`${kind}:${text(node.id)}`)
      if (!nodeRef) continue
      const ids = Array.isArray(node.deviceIds) ? node.deviceIds.map(text) : node.deviceBindingId ? [text(node.deviceBindingId)] : []
      for (const twinId of ids) {
        const twinRef = twinRefById.get(twinId)
        if (twinRef) relations.push({ id: `${kind}-${text(node.id)}-twin-${twinId}`, kind: `industrial.${kind === 'daq' ? 'measures' : 'controls'}`, src: nodeRef, dst: twinRef, evidenceRefs: [] })
      }
    }
  }

  const serializableSource = { lines, products, recipes, runs, dcwNodes, daqNodes, bindings, twins }
  const source: ProjectionSource = { adapterId, version, sourceRef: sourceRef(lineId), sourceRevision: canonicalHash(serializableSource).slice(0, 16), contentHash: canonicalHash(serializableSource), capturedAt: now }
  const snapshot = projectContext({
    id: request.id ?? `industrial-context-${lineId ?? 'all'}`,
    scope: request.scope,
    window: request.window,
    source,
    subjects: subjects as never,
    objects: objects as never,
    attributes: attributes as never,
    materialAssignments: materialAssignments as never,
    relations: relations as never,
    schemaRefs: [{ extensionId: 'industrial-process', version: '1.0.0' }],
  })
  return { snapshot, source: { adapterId, version, ...(lineId ? { lineId } : {}), counts: { lines: lines.length, products: products.length, recipes: recipes.length, runs: runs.length, dcwNodes: dcwNodes.length, daqNodes: daqNodes.length, bindings: bindings.length, twins: twins.length } } }
}

function payloadOf(request: ContextAdapterOperationRequest): IndustrialReadRequest {
  if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) return {}
  return request.payload as IndustrialReadRequest
}

export function createIndustrialReadAdapter(options: {
  adapterId?: string
  version?: string
  generation?: number
  ownerId?: string
  services?: ReadServices
  now?: () => string
  authorize?: ContextAdapterAuthorizer
} = {}): ContextAdapter {
  const adapterId = options.adapterId ?? INDUSTRIAL_READ_ADAPTER_ID
  const version = options.version ?? INDUSTRIAL_READ_ADAPTER_VERSION
  const services = options.services ?? defaultServices()
  const now = options.now ?? (() => new Date().toISOString())
  const snapshot = (request: ContextAdapterOperationRequest): IndustrialReadPayload => {
    const authorization = request.authorization
    if (options.authorize && (!authorization?.industrial || authorization.lineIds.length === 0)) throw new Error('industrial adapter requires authorized line bindings')
    const requested = payloadOf(request)
    const requestedLineId = text(requested.lineId) || undefined
    const requestedScope = requested.scope as (typeof requested.scope & { lineIds?: readonly string[] }) | undefined
    const requestedLineIds: string[] = Array.isArray(requestedScope?.lineIds) ? requestedScope.lineIds.map(text).filter((lineId): lineId is string => Boolean(lineId)) : []
    if (authorization) {
      const allowed = new Set(authorization.lineIds)
      if (requestedLineId && !allowed.has(requestedLineId)) throw new Error('industrial projection line is outside authorized bindings')
      if (requestedLineIds.some(lineId => !allowed.has(lineId))) throw new Error('industrial projection line is outside authorized bindings')
    }
    const lineId = requestedLineId ?? (requestedLineIds.length === 1 ? requestedLineIds[0] : undefined)
    return projectIndustrialRead(services, { ...requested, lineId }, adapterId, version, now())
  }
  const discover = (request: ContextAdapterOperationRequest) => {
    const authorization = request.authorization
    if (options.authorize && (!authorization?.industrial || authorization.lineIds.length === 0)) throw new Error('industrial adapter requires authorized line bindings')
    const payload = payloadOf(request)
    const requestedLineId = text(payload.lineId) || undefined
    if (authorization && requestedLineId && !authorization.lineIds.includes(requestedLineId)) throw new Error('industrial discovery line is outside authorized bindings')
    const lineIds = authorization ? (requestedLineId ? [requestedLineId] : [...authorization.lineIds]) : (requestedLineId ? [requestedLineId] : undefined)
    const lines = lineIds ? services.lines.all().filter(item => lineIds.includes(text(item.id))) : services.lines.all()
    return { adapterId, version, lineId: requestedLineId, refs: lines.map(item => contextRef('industrial.line', text(item.id))), counts: { lines: lines.length, products: selected(services.products.all(), requestedLineId).length, recipes: selected(services.recipes.list(), requestedLineId).length } }
  }
  const capabilities = { discover: true, snapshot: true, observe: false, query: true, simulate: false, replay: false, verify: false, export: false } as const
  return {
    adapterId,
    apiVersion: 'context-adapter.v1',
    version,
    capabilities,
    sideEffect: 'none',
    ...(options.authorize ? { requiresAuthorization: true, authorize: options.authorize } : {}),
    generation: options.generation ?? 1,
    health: { status: 'healthy', checkedAt: now(), details: { readOnly: true } },
    timeout: { defaultMs: 5000, maxMs: 30000 },
    owner: { ownerId: options.ownerId ?? 'industrial-context', dispose: async () => undefined },
    discover,
    snapshot,
    query: snapshot,
    drain: async () => undefined,
    retire: async () => undefined,
  }
}

export { projectIndustrialRead }
