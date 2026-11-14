import type {
  Attribute,
  ContextAdapter,
  ContextAdapterOperationRequest,
  ContextAdapterAuthorizer,
  ContextAdapterAuthorizationContext,
  ContextRef,
  ContextScope,
  ContextSubject,
  DomainObject,
  MaterialAssignment,
} from '../contracts'
import { canonicalHash } from '@/shared/context/hash'
import type { DaqFrameQueryOpts, DaqFrameRecord, TsdbHistoryQuery, TsdbHistoryResult, TsdbPoint, TsdbTagQuery } from '../../daq/storage/tsdb-port'
import type { InterventionEventRow } from '../../aml/intervention-ledger'
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

export type IndustrialReadScope = ContextScope & {
  /** Adapter-local selectors; generic context contracts do not carry these fields. */
  lineId?: string
  lineIds?: readonly string[]
  projection?: string
  industrial?: boolean
}

export type IndustrialReadRequest = {
  id?: string
  lineId?: string
  lineIds?: readonly string[]
  scope?: IndustrialReadScope
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

/**
 * PR-C(2026-11-14):只读运行证据 —— 通过既有 DAQ/DCW 权威读取
 * (TSDB latest/history/tagged/frames、DCW 节点回读/ACK 状态、干预台账写审计),
 * 不引入任何写入/审批路径。窗口必须由调用方显式给出(历史读取),避免隐式全表扫描。
 */
export type IndustrialOperationalWindow = {
  fromMs: number
  toMs: number
  bucketMs?: number
  limit?: number
}

export type IndustrialOperationalRequest = {
  id?: string
  lineId?: string
  lineIds?: readonly string[]
  scope?: IndustrialReadScope
  daqNodeIds?: readonly string[]
  dcwNodeIds?: readonly string[]
  window?: IndustrialOperationalWindow
  history?: boolean
  tagged?: boolean
  frames?: boolean | { kind?: 'vector' | 'image', limit?: number }
  writeAudit?: boolean | { limit?: number }
  staleAfterMs?: number
}

export type IndustrialOperationalPorts = {
  now?: () => number
  latest?: (nodeId: string, q: { fromMs: number, toMs: number, bucketMs?: number, limit?: number }) => Promise<TsdbPoint[]>
  history?: (nodeId: string, q: TsdbHistoryQuery) => Promise<TsdbHistoryResult>
  tagged?: (q: TsdbTagQuery) => Promise<Map<string, TsdbPoint[]>>
  frames?: (nodeId: string, q: DaqFrameQueryOpts) => Promise<DaqFrameRecord[]>
  writeAudit?: (filter: { nodeId?: string, lineId?: string, limit?: number }) => Promise<InterventionEventRow[]>
}

export type IndustrialOperationalEvidence = {
  adapterId: string
  version: string
  capturedAt: string
  readOnly: true
  writeCount: 0
  source: {
    lineId?: string
    lineIds: string[]
    counts: Record<string, number>
    contentHash: string
    sourceRevision: string
  }
  daq: Array<Record<string, unknown>>
  dcw: Array<Record<string, unknown>>
}

function defaultOperationalPorts(): IndustrialOperationalPorts {
  return {
    now: () => Date.now(),
    latest: async (nodeId, q) => {
      const [{ getTsdb }, { queryLatest }] = await Promise.all([
        import('../../daq/storage'),
        import('../../daq/storage/latest-window'),
      ])
      return queryLatest(getTsdb(), nodeId, q)
    },
    history: async (nodeId, q) => {
      const { tsdbQueryHistory } = await import('../../daq/storage')
      return tsdbQueryHistory(nodeId, q)
    },
    tagged: async (q) => {
      const [{ getTsdb }, { queryTaggedLatest }] = await Promise.all([
        import('../../daq/storage'),
        import('../../daq/storage/latest-window'),
      ])
      return queryTaggedLatest(getTsdb(), q)
    },
    frames: async (nodeId, q) => {
      const { getTsdb } = await import('../../daq/storage')
      return getTsdb().queryFrames(nodeId, q)
    },
    writeAudit: async (filter) => {
      const { listInterventions } = await import('../../aml/intervention-ledger')
      return listInterventions(filter)
    },
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

function sourceRef(lineId?: string, lineIds?: readonly string[]): string {
  return `industrial.read:${lineId || (lineIds?.length ? lineIds.join(',') : 'all')}`
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

function selected<T extends ReadRecord>(items: readonly T[], lineId: string | undefined, lineIds?: readonly string[]): T[] {
  if (lineId) return items.filter(item => text(item.lineId) === lineId)
  if (lineIds?.length) return items.filter(item => lineIds.includes(text(item.lineId)))
  return [...items]
}

function selectedTwins(services: ReadServices, nodeRecords: readonly ReadRecord[], lineId?: string, lineIds?: readonly string[]): ReadRecord[] {
  const ids = new Set<string>()
  for (const node of nodeRecords) {
    const deviceIds = Array.isArray(node.deviceIds) ? node.deviceIds : []
    for (const id of deviceIds) ids.add(text(id))
    if (node.deviceBindingId) ids.add(text(node.deviceBindingId))
  }
  const twins = services.twins.listAll()
  if (!lineId && !lineIds?.length) return ids.size > 0 ? twins.filter(twin => ids.has(text(twin.id))) : [...twins]
  return twins.filter(twin => ids.has(text(twin.id)))
}

function projectIndustrialRead(services: ReadServices, request: IndustrialReadRequest, adapterId: string, version: string, now: string): IndustrialReadPayload {
  const lineId = text(request.lineId) || undefined
  const lineIds = Array.isArray(request.lineIds) ? [...new Set(request.lineIds.map(text).filter(Boolean))] : undefined
  const lines = lineId ? services.lines.all().filter(item => text(item.id) === lineId) : lineIds?.length ? services.lines.all().filter(item => lineIds.includes(text(item.id))) : [...services.lines.all()]
  const selectedLineIds = lineId ? [lineId] : lineIds
  const products = selected(services.products.all(), lineId, lineIds)
  const recipes = selected(services.recipes.list(), lineId, lineIds)
  const recipeIds = new Set(recipes.map(item => text(item.id)))
  const runs = selected(services.recipes.listRuns(), lineId, lineIds).filter(item => (!lineId && !lineIds?.length) || recipeIds.has(text(item.recipeId)))
  const dcwNodes = selected(services.dcwNodes.all(), lineId, lineIds).map(asView)
  const daqNodes = selected(services.daqNodes.all(), lineId, lineIds).map(asView)
  const bindings = [...services.bindings.all()].filter((item) => {
    if (!lineId && !lineIds?.length) return true
    const kind = text(item.kind)
    const nodeId = text(item.nodeId)
    if (kind === 'line-recipe') return lineId ? nodeId === lineId : lineIds?.includes(nodeId) ?? false
    if (kind === 'recipe') return recipeIds.has(nodeId)
    return dcwNodes.some(node => text(node.id) === nodeId) || daqNodes.some(node => text(node.id) === nodeId)
  })
  const twins = selectedTwins(services, [...dcwNodes, ...daqNodes], lineId, lineIds)
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
  const source: ProjectionSource = { adapterId, version, sourceRef: sourceRef(lineId, selectedLineIds), sourceRevision: canonicalHash(serializableSource).slice(0, 16), contentHash: canonicalHash(serializableSource), capturedAt: now }
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

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function timeMsOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function uniqueStrings(values: readonly unknown[] | undefined): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))]
}

const MAX_OPERATIONAL_NODES = 50

function selectOperationalNodes(
  views: ReadRecord[],
  explicitIds: readonly unknown[] | undefined,
  kind: 'DAQ' | 'DCW',
): ReadRecord[] {
  const ids = uniqueStrings(explicitIds)
  if (ids.length > MAX_OPERATIONAL_NODES) throw new Error(`too many ${kind} nodes requested (max ${MAX_OPERATIONAL_NODES})`)
  if (ids.length === 0) {
    if (views.length > MAX_OPERATIONAL_NODES) throw new Error(`too many ${kind} nodes in scope (${views.length}); specify ${kind === 'DAQ' ? 'daqNodeIds' : 'dcwNodeIds'}`)
    return views
  }
  const byId = new Map(views.map(node => [text(node.id), node]))
  return ids.map((id) => {
    const node = byId.get(id)
    if (!node) throw new Error(`${kind} node is outside authorized line bindings: ${id}`)
    return node
  })
}

async function projectIndustrialOperational(
  services: ReadServices,
  ports: IndustrialOperationalPorts,
  request: IndustrialOperationalRequest,
  authorizationLineIds: string[],
  adapterId: string,
  version: string,
  capturedAt: string,
): Promise<IndustrialOperationalEvidence> {
  const requestedLineId = text(request.lineId) || undefined
  const requestedLineIds = uniqueStrings([
    ...(Array.isArray(request.lineIds) ? request.lineIds : []),
    ...(Array.isArray(request.scope?.lineIds) ? request.scope.lineIds : []),
  ])
  if (requestedLineId && !authorizationLineIds.includes(requestedLineId)) throw new Error('operational line is outside authorized bindings')
  if (requestedLineIds.some(lineId => !authorizationLineIds.includes(lineId))) throw new Error('operational line is outside authorized bindings')
  const lineIds = requestedLineId
    ? [requestedLineId]
    : requestedLineIds.length > 0
      ? requestedLineIds
      : [...authorizationLineIds]
  const inScope = (lineValue: unknown): boolean => lineIds.length === 0 || lineIds.includes(text(lineValue))
  const daqNodes = selectOperationalNodes(
    services.daqNodes.all().map(asView).filter(node => inScope(node.lineId)),
    request.daqNodeIds,
    'DAQ',
  )
  const dcwNodes = selectOperationalNodes(
    services.dcwNodes.all().map(asView).filter(node => inScope(node.lineId)),
    request.dcwNodeIds,
    'DCW',
  )

  const nowMs = ports.now?.() ?? (Number.isFinite(Date.parse(capturedAt)) ? Date.parse(capturedAt) : Date.now())
  const staleAfterMs = Math.max(1, Math.min(finiteNumber(request.staleAfterMs) ?? 60_000, 86_400_000))
  const windowFrom = finiteNumber(request.window?.fromMs)
  const windowTo = finiteNumber(request.window?.toMs)
  const bucketMs = Math.max(100, finiteNumber(request.window?.bucketMs) ?? 1000)
  const pointLimit = Math.max(1, Math.min(finiteNumber(request.window?.limit) ?? 200, 5000))
  const history = request.history === true
  const tagged = request.tagged === true
  if ((history || tagged) && (windowFrom == null || windowTo == null || windowFrom >= windowTo)) {
    throw new Error('operational history requires an explicit fromMs < toMs window')
  }
  const latestFrom = windowFrom ?? nowMs - 15 * 60_000
  const latestTo = windowTo ?? nowMs
  if (latestFrom >= latestTo) throw new Error('operational window must satisfy fromMs < toMs')

  const taggedPoints = tagged && ports.tagged
    ? await ports.tagged({ nodeIds: daqNodes.map(node => text(node.id)), fromMs: windowFrom!, toMs: windowTo!, bucketMs, limit: pointLimit })
    : undefined
  const frameRequest = request.frames === true
    ? {}
    : request.frames && typeof request.frames === 'object' ? request.frames : null
  const frameKind = frameRequest?.kind === 'vector' || frameRequest?.kind === 'image' ? frameRequest.kind : undefined
  const frameLimit = Math.max(1, Math.min(finiteNumber(frameRequest?.limit) ?? 20, 100))

  const daq: Array<Record<string, unknown>> = []
  let historyPoints = 0
  let taggedCount = 0
  let frameCount = 0
  for (const node of daqNodes) {
    const nodeId = text(node.id)
    const points = ports.latest
      ? await ports.latest(nodeId, { fromMs: latestFrom, toMs: latestTo, bucketMs, limit: Math.min(pointLimit, 500) })
      : []
    const lastPoint = points.length > 0 ? points[points.length - 1]! : null
    const atCandidates = [timeMsOf(node.lastAt), lastPoint?.at]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const at = atCandidates.length > 0 ? Math.max(...atCandidates) : null
    const value = finiteNumber(node.value) ?? finiteNumber(lastPoint?.value) ?? finiteNumber(lastPoint?.avg)
    const ageMs = at == null ? null : Math.max(0, nowMs - at)
    const freshness = ageMs == null ? 'missing' : ageMs <= staleAfterMs ? 'fresh' : 'stale'
    const historyResult = history && ports.history
      ? await ports.history(nodeId, { fromMs: windowFrom!, toMs: windowTo!, bucketMs, limit: pointLimit })
      : undefined
    if (historyResult) historyPoints += historyResult.points.length
    const tags = taggedPoints?.get(nodeId) ?? []
    taggedCount += tags.length
    const frames = frameRequest && ports.frames
      ? (await ports.frames(nodeId, { fromMs: latestFrom, toMs: latestTo, ...(frameKind ? { kind: frameKind } : {}), limit: frameLimit })).map(frame => ({
          at: frame.at,
          kind: frame.kind,
          metrics: frame.metrics,
          meta: frame.meta,
          ...(Array.isArray(frame.points) ? { pointCount: frame.points.length, points: frame.points.slice(0, 256) } : {}),
          productId: frame.productId ?? null,
          recipeId: frame.recipeId ?? null,
          runId: frame.runId ?? null,
        }))
      : undefined
    frameCount += frames?.length ?? 0
    daq.push({
      nodeId,
      lineId: text(node.lineId),
      name: labelOf(node, nodeId),
      unit: text(node.unit),
      driver: text(node.driver),
      enabled: node.enabled === true,
      latest: { value, at, ageMs, freshness },
      ...(lastPoint ? { latestPoint: lastPoint } : {}),
      ...(historyResult ? { history: { resolution: historyResult.resolution, coverage: historyResult.coverage, points: historyResult.points } } : {}),
      ...(tagged ? { tagged: tags } : {}),
      ...(frames ? { frames } : {}),
    })
  }

  const auditRequested = request.writeAudit !== false
  const auditLimit = Math.max(1, Math.min(finiteNumber(typeof request.writeAudit === 'object' ? request.writeAudit?.limit : undefined) ?? 10, 50))
  let auditRows = 0
  const dcw: Array<Record<string, unknown>> = []
  for (const node of dcwNodes) {
    const nodeId = text(node.id)
    const lastAckAt = text(node.lastAckAt) || null
    const ackMs = timeMsOf(lastAckAt)
    const ackAgeMs = ackMs == null ? null : Math.max(0, nowMs - ackMs)
    const rows = auditRequested && ports.writeAudit
      ? await ports.writeAudit({ nodeId, lineId: text(node.lineId), limit: auditLimit })
      : []
    auditRows += rows.length
    dcw.push({
      nodeId,
      lineId: text(node.lineId),
      name: labelOf(node, nodeId),
      unit: text(node.unit),
      enabled: node.enabled === true,
      value: finiteNumber(node.value),
      readValue: finiteNumber(node.readValue),
      lastAckAt,
      ackAgeMs,
      ackFresh: ackAgeMs != null && ackAgeMs <= staleAfterMs,
      lastWriteAt: text(node.lastWriteAt) || null,
      state: text(node.state) || null,
      lastError: text(node.lastError) || null,
      stepLimit: finiteNumber(node.stepLimit),
      limits: { min: finiteNumber(node.min), max: finiteNumber(node.max) },
      writeAudit: rows.map(row => ({
        id: row.id,
        at: row.ts,
        fromValue: row.fromValue,
        toValue: row.toValue,
        actualValue: row.actualValue,
        ack: row.ack,
        path: row.path,
        actor: row.actor,
        actorName: row.actorName,
        approvalId: row.approvalId,
        recipeRunId: row.recipeRunId,
        verdict: row.verdict,
        effect: row.effect,
      })),
    })
  }

  const counts = {
    daqNodes: daq.length,
    dcwNodes: dcw.length,
    historyPoints,
    taggedPoints: taggedCount,
    frames: frameCount,
    writeAudit: auditRows,
  }
  const contentHash = canonicalHash({ lineIds, daq, dcw })
  return {
    adapterId,
    version,
    capturedAt,
    readOnly: true,
    writeCount: 0,
    source: {
      ...(requestedLineId ? { lineId: requestedLineId } : {}),
      lineIds,
      counts,
      contentHash,
      sourceRevision: contentHash.slice(0, 16),
    },
    daq,
    dcw,
  }
}

function payloadOf(request: ContextAdapterOperationRequest): IndustrialReadRequest {
  if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) return {}
  return request.payload as IndustrialReadRequest
}

function boundLineIdsOf(authorization: ContextAdapterAuthorizationContext | undefined): string[] {
  const raw = authorization?.metadata?.boundLineIds
  return Array.isArray(raw) ? raw.map(text).filter((lineId): lineId is string => Boolean(lineId)) : []
}

export function createIndustrialReadAdapter(options: {
  adapterId?: string
  version?: string
  generation?: number
  ownerId?: string
  services?: ReadServices
  operational?: IndustrialOperationalPorts
  now?: () => string
  authorize?: ContextAdapterAuthorizer
} = {}): ContextAdapter {
  const adapterId = options.adapterId ?? INDUSTRIAL_READ_ADAPTER_ID
  const version = options.version ?? INDUSTRIAL_READ_ADAPTER_VERSION
  const services = options.services ?? defaultServices()
  const operational: IndustrialOperationalPorts = { ...defaultOperationalPorts(), ...options.operational }
  const now = options.now ?? (() => new Date().toISOString())
  const snapshot = (request: ContextAdapterOperationRequest): IndustrialReadPayload => {
    const authorization = request.authorization
    const boundLineIds = boundLineIdsOf(authorization)
    if (options.authorize && (!authorization?.industrial || boundLineIds.length === 0)) throw new Error('industrial adapter requires authorized line bindings')
    const requested = payloadOf(request)
    const requestedLineId = text(requested.lineId) || undefined
    const requestedScope = requested.scope as IndustrialReadScope | undefined
    const requestedLineIds = [...new Set([
      ...(Array.isArray(requested.lineIds) ? requested.lineIds : []),
      ...(Array.isArray(requestedScope?.lineIds) ? requestedScope.lineIds : []),
    ].map(text).filter((lineId): lineId is string => Boolean(lineId)))]
    if (authorization) {
      const allowed = new Set(boundLineIdsOf(authorization))
      if (requestedLineId && !allowed.has(requestedLineId)) throw new Error('industrial projection line is outside authorized bindings')
      if (requestedLineIds.some(lineId => !allowed.has(lineId))) throw new Error('industrial projection line is outside authorized bindings')
    }
    const lineId = requestedLineId ?? (requestedLineIds.length === 1 ? requestedLineIds[0] : undefined)
    const authorizedLineIds = boundLineIds
    if (authorization && requestedLineIds.length === 0 && authorizedLineIds.length === 0) throw new Error('industrial adapter requires authorized line bindings')
    return projectIndustrialRead(services, { ...requested, lineId, lineIds: authorizedLineIds }, adapterId, version, now())
  }
  const discover = (request: ContextAdapterOperationRequest) => {
    const authorization = request.authorization
    const boundLineIds = boundLineIdsOf(authorization)
    if (options.authorize && (!authorization?.industrial || boundLineIds.length === 0)) throw new Error('industrial adapter requires authorized line bindings')
    const payload = payloadOf(request)
    const requestedLineId = text(payload.lineId) || undefined
    const requestedLineIds = Array.isArray(payload.lineIds) ? payload.lineIds.map(text).filter(Boolean) : []
    if (authorization && requestedLineId && !boundLineIds.includes(requestedLineId)) throw new Error('industrial discovery line is outside authorized bindings')
    if (authorization && requestedLineIds.some(lineId => !boundLineIds.includes(lineId))) throw new Error('industrial discovery line is outside authorized bindings')
    const authorizedLineIds = boundLineIds
    const lineIds = authorization ? (requestedLineId ? [requestedLineId] : requestedLineIds.length ? requestedLineIds : [...authorizedLineIds]) : (requestedLineId ? [requestedLineId] : requestedLineIds.length ? requestedLineIds : undefined)

    const lines = lineIds ? services.lines.all().filter(item => lineIds.includes(text(item.id))) : services.lines.all()
    return { adapterId, version, lineId: requestedLineId, refs: lines.map(item => contextRef('industrial.line', text(item.id))), counts: { lines: lines.length, products: selected(services.products.all(), requestedLineId, lineIds).length, recipes: selected(services.recipes.list(), requestedLineId, lineIds).length } }
  }
  /** PR-C:只读运行证据(DAQ latest/history/tagged/frames + DCW ACK/回读/写审计)。 */
  const observe = async (request: ContextAdapterOperationRequest): Promise<IndustrialOperationalEvidence> => {
    const authorization = request.authorization
    const boundLineIds = boundLineIdsOf(authorization)
    if (options.authorize && (!authorization?.industrial || boundLineIds.length === 0)) throw new Error('operational evidence requires authorized line bindings')
    const payload = payloadOf(request) as IndustrialOperationalRequest
    return projectIndustrialOperational(services, operational, payload, boundLineIds, adapterId, version, now())
  }
  const capabilities = { discover: true, snapshot: true, observe: true, query: true, simulate: false, replay: false, verify: false, export: false } as const
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
    observe,
    query: snapshot,
    drain: async () => undefined,
    retire: async () => undefined,
  }
}

export { projectIndustrialRead }
