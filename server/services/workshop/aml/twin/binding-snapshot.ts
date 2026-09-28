import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createId, sha256, type NodeBindingSnapshot as ContractNodeBindingSnapshot, type SceneContract } from './contracts'
import { sceneContractHash, sceneStatus, type SceneWithDraftMetadata } from './scene-lifecycle'
import { dataDirFor } from '@/shared/config/home.mjs'
import { withWorkshopDbReadonly } from '../../db/readonly'

export type BindingControlPolicy = 'recommendation_only' | 'hitl_governed' | 'bounded_auto'
export type BindingNodeKind = 'daq' | 'dcw'
export type BindingMode = 'auto' | 'manual'

export type NodeBindingSnapshotBinding = ContractNodeBindingSnapshot['bindings'][number] & {
  productId?: string
  recipeId?: string
}

/**
 * The legacy contract in contracts.ts remains readable by existing callers.
 * This local authority type carries the immutable lineage needed by P0.
 */
export interface AuthoritativeNodeBindingSnapshot extends Omit<ContractNodeBindingSnapshot, 'bindings'> {
  lineId: string
  productId?: string
  recipeId?: string
  recipeVersion?: string | number
  recipeHash?: string
  sceneContractHash?: string
  bindings: NodeBindingSnapshotBinding[]
}

export type NodeBindingSnapshot = AuthoritativeNodeBindingSnapshot
export type BindingSnapshot = AuthoritativeNodeBindingSnapshot

export interface BindingSource {
  id?: string
  channelId?: string
  agentId: string
  agentRole?: string
  nodeId: string
  kind: BindingNodeKind
  mode: BindingMode
  controlPolicy?: BindingControlPolicy
  lineId?: string
  productId?: string
  recipeId?: string
  physicalMeaning?: string
  unit?: string
  min?: number
  max?: number
  samplePeriodMs?: number
  createdAt?: string
  name?: string
  semantics?: string
  intervalMs?: number | null
  samplingPeriodMs?: number | null
  readIntervalMs?: number | null
  holdIntervalMs?: number | null
}

export interface NodeBindingSnapshotInput {
  channelId: string
  createdBy: string
  scene?: SceneContract | SceneWithDraftMetadata
  sceneContract?: SceneContract | SceneWithDraftMetadata
  sceneId?: string
  sceneVersion?: string
  agentId?: string
  agentRole?: string
  lineId?: string
  productId?: string
  recipeId?: string
  recipeVersion?: string | number
  recipe?: unknown
  recipeHash?: string
  controlPolicy?: BindingControlPolicy
  bindings?: readonly BindingSource[]
  currentBindings?: readonly BindingSource[]
  agentBindings?: readonly BindingSource[]
  bindingRecords?: readonly BindingSource[]
  nodeCatalog?: Record<string, Partial<BindingSource>> | readonly Partial<BindingSource>[]
  nodes?: Record<string, Partial<BindingSource>> | readonly Partial<BindingSource>[]
  snapshotId?: string
  nowMs?: number
  expectedBindingEpoch?: string
  requireFrozenScene?: boolean
}

export interface NodeBindingSnapshotVerifyOptions {
  scene?: SceneContract | SceneWithDraftMetadata
  frozenScene?: SceneContract | SceneWithDraftMetadata
  expectedChannelId?: string
  expectedSceneId?: string
  expectedSceneVersion?: string
  expectedLineId?: string
  productId?: string
  recipeId?: string
  recipeVersion?: string | number
  recipe?: unknown
  recipeHash?: string
  expectedSnapshotHash?: string
  expectedBindingSnapshotHash?: string
  currentBindingEpoch?: string
  expectedBindingEpoch?: string
  currentSnapshot?: unknown
  nowMs?: number
  maxAgeMs?: number
  requireFrozenScene?: boolean
  requireRecipe?: boolean
}

export interface BindingSnapshotValidationResult {
  valid: boolean
  errors: string[]
  calculatedHash?: string
  calculatedBindingEpoch?: string
}

type AnyRecord = Record<string, unknown>

function record(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' ? value as AnyRecord : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function optionalText(value: unknown): string | undefined {
  const result = text(value)
  return result || undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sameOptional(a: unknown, b: unknown): boolean {
  return optionalText(a) === optionalText(b)
}

function sceneOf(input: NodeBindingSnapshotInput): SceneContract | SceneWithDraftMetadata | undefined {
  return input.scene ?? input.sceneContract
}

function sceneIdOf(scene: unknown): string | undefined {
  return optionalText(record(scene)?.sceneId)
}

function sceneVersionOf(scene: unknown): string | undefined {
  return optionalText(record(scene)?.sceneVersion)
}

function sceneLineIdOf(scene: unknown): string | undefined {
  return optionalText(record(scene)?.lineId)
}

function sceneProductIdOf(scene: unknown): string | undefined {
  return optionalText(record(scene)?.productId)
}

function sceneRecipeIdOf(scene: unknown): string | undefined {
  return optionalText(record(scene)?.recipeId)
}

function recipeIdOf(recipe: unknown): string | undefined {
  const value = record(recipe)
  return optionalText(value?.id ?? value?.recipeId)
}

function recipeProductIdOf(recipe: unknown): string | undefined {
  return optionalText(record(recipe)?.productId)
}

function recipeLineIdOf(recipe: unknown): string | undefined {
  return optionalText(record(recipe)?.lineId)
}

function recipeVersionOf(recipe: unknown): string | number | undefined {
  const value = record(recipe)?.version ?? record(recipe)?.recipeVersion
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export function canonicalRecipeHash(recipe: unknown, explicitHash?: string): string | undefined {
  const supplied = optionalText(explicitHash)
  if (supplied) return supplied
  if (recipe == null) return undefined
  const value = record(recipe)
  return optionalText(value?.recipeHash ?? value?.hash) ?? sha256(recipe)
}

export const recipeHash = canonicalRecipeHash

function isFrozenScene(scene: unknown): boolean {
  const value = record(scene)
  if (!value) return false
  return value.status === 'frozen' || sceneStatus(scene as SceneWithDraftMetadata) === 'frozen'
}

function nodeCatalogEntry(input: NodeBindingSnapshotInput, source: BindingSource): AnyRecord | undefined {
  const catalog = input.nodeCatalog ?? input.nodes
  if (!catalog) return undefined
  if (Array.isArray(catalog)) {
    return catalog.find(item => text(item.nodeId) === source.nodeId) as AnyRecord | undefined
  }
  return record((catalog as Record<string, Partial<BindingSource>>)[source.nodeId]) ?? undefined
}

function dataFile(name: string): string {
  return join(dataDirFor(), name)
}

function readJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(dataFile(name), 'utf8'))
  }
  catch {
    return undefined
  }
}

function channelAgents(channelId: string): Map<string, { channelId: string, role: string, enabled: boolean }> {
  return withWorkshopDbReadonly((db) => {
    const rows = db.prepare('SELECT id, channel_id AS channelId, role, enabled FROM channel_agents WHERE channel_id = ?').all(channelId) as Array<Record<string, unknown>>
    return new Map(rows.map(row => [
      text(row.id),
      { channelId: text(row.channelId), role: text(row.role) || 'worker', enabled: Number(row.enabled ?? 1) !== 0 },
    ]))
  }, () => new Map())
}

function liveBindingSources(input: NodeBindingSnapshotInput): BindingSource[] {
  const agents = channelAgents(input.channelId)
  if (!agents.size) throw new Error('BINDING_CHANNEL_UNRESOLVED')
  const rows = readJson('agent-node-bindings.json')
  const bindings = Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
  const selected = bindings
    .filter(row => input.agentId ? text(row.agentId) === input.agentId : agents.has(text(row.agentId)))
    .filter(row => agents.get(text(row.agentId))?.channelId === input.channelId)
    .filter(row => agents.get(text(row.agentId))?.enabled !== false)
    .map(row => ({
      id: text(row.id),
      channelId: input.channelId,
      agentId: text(row.agentId),
      agentRole: agents.get(text(row.agentId))?.role ?? input.agentRole,
      nodeId: text(row.nodeId),
      kind: text(row.kind) as BindingNodeKind,
      mode: text(row.mode) as BindingMode,
      createdAt: text(row.createdAt),
    }))
  if (input.agentId && !agents.has(input.agentId)) throw new Error('BINDING_AGENT_CHANNEL_MISMATCH')
  return selected
}

function nodeFromRepositories(source: BindingSource): AnyRecord | undefined {
  const rows = readJson(source.kind === 'daq' ? 'daqs.json' : 'dcws.json')
  if (!Array.isArray(rows)) return undefined
  return rows.find(row => text(record(row)?.id) === source.nodeId) as AnyRecord | undefined
}

function activeRunFor(lineId?: string): AnyRecord | undefined {
  if (!lineId) return undefined
  const rows = readJson('line-runs.json')
  if (!Array.isArray(rows)) return undefined
  return rows.find(row => text(record(row)?.lineId) === lineId) as AnyRecord | undefined
}

function resolveRecipe(input: NodeBindingSnapshotInput, recipeId?: string): unknown {
  if (input.recipe != null || !recipeId) return input.recipe
  const rows = readJson('dcw-recipes.json')
  if (!Array.isArray(rows)) return undefined
  return rows.find(row => recipeIdOf(row) === recipeId)
}

function channelPolicy(channelId: string): BindingControlPolicy | undefined {
  return withWorkshopDbReadonly((db) => {
    const row = db.prepare('SELECT control_policy AS controlPolicy FROM aml_channel_profiles WHERE channel_id = ?').get(channelId) as Record<string, unknown> | undefined
    const policy = text(row?.controlPolicy)
    return ['recommendation_only', 'hitl_governed', 'bounded_auto'].includes(policy) ? policy as BindingControlPolicy : undefined
  }, () => undefined)
}

function resolvedPolicy(input: NodeBindingSnapshotInput): BindingControlPolicy {
  if (input.controlPolicy) return input.controlPolicy
  return channelPolicy(input.channelId) ?? 'recommendation_only'
}

function samplePeriodOf(source: BindingSource, node: AnyRecord | undefined): number | undefined {
  // DCW is an actuator binding; its PLC read/hold interval is not a DAQ sampling period.
  if (source.kind === 'dcw' && source.samplePeriodMs == null && source.samplingPeriodMs == null) return undefined
  const supplied = source.samplePeriodMs ?? source.samplingPeriodMs
  if (supplied != null) return Number(supplied)
  const raw = node?.intervalMs ?? node?.samplingPeriodMs ?? node?.readIntervalMs ?? node?.holdIntervalMs
  return raw == null ? undefined : Number(raw)
}

function normalizedBinding(input: NodeBindingSnapshotInput, source: BindingSource, lineId: string, productId?: string, recipeId?: string): NodeBindingSnapshotBinding {
  if (source.kind !== 'daq' && source.kind !== 'dcw') throw new Error(`BINDING_KIND_INVALID:${source.nodeId}`)
  if (source.mode !== 'auto' && source.mode !== 'manual') throw new Error(`BINDING_MODE_INVALID:${source.nodeId}`)
  const node = nodeCatalogEntry(input, source) ?? nodeFromRepositories(source)
  const physicalMeaning = optionalText(source.physicalMeaning ?? source.semantics ?? node?.physicalMeaning ?? node?.semantics ?? node?.name)
  const unit = optionalText(source.unit ?? node?.unit)
  const min = source.min ?? (finite(node?.min) ? node.min : undefined)
  const max = source.max ?? (finite(node?.max) ? node.max : undefined)
  const sourceLineId = optionalText(source.lineId ?? node?.lineId) ?? lineId
  const sourceProductId = optionalText(source.productId ?? node?.productId) ?? productId
  const sourceRecipeId = optionalText(source.recipeId ?? node?.recipeId) ?? recipeId
  if (!source.agentId || !source.nodeId) throw new Error('BINDING_FIELD_REQUIRED')
  if (sourceLineId !== lineId) throw new Error(`BINDING_LINE_MISMATCH:${source.nodeId}`)
  if ((min != null && !finite(min)) || (max != null && !finite(max))) throw new Error(`BINDING_RANGE_INVALID:${source.nodeId}`)
  if (min != null && max != null && min > max) throw new Error(`BINDING_RANGE_ORDER:${source.nodeId}`)
  if (!physicalMeaning || !unit) throw new Error(`BINDING_SEMANTICS_REQUIRED:${source.nodeId}`)
  const samplePeriodMs = samplePeriodOf(source, node)
  if (samplePeriodMs != null && (!finite(samplePeriodMs) || samplePeriodMs <= 0)) throw new Error(`BINDING_SAMPLE_PERIOD_INVALID:${source.nodeId}`)
  const controlPolicy = source.controlPolicy ?? resolvedPolicy(input)
  if (!['recommendation_only', 'hitl_governed', 'bounded_auto'].includes(controlPolicy)) throw new Error(`BINDING_POLICY_INVALID:${source.nodeId}`)
  return {
    agentId: source.agentId,
    agentRole: optionalText(source.agentRole) ?? input.agentRole ?? 'worker',
    nodeId: source.nodeId,
    kind: source.kind,
    mode: source.mode,
    controlPolicy,
    lineId,
    physicalMeaning,
    unit,
    ...(min != null ? { min } : {}),
    ...(max != null ? { max } : {}),
    ...(samplePeriodMs != null ? { samplePeriodMs } : {}),
    ...(sourceProductId ? { productId: sourceProductId } : {}),
    ...(sourceRecipeId ? { recipeId: sourceRecipeId } : {}),
  }
}

function bindingSort(a: NodeBindingSnapshotBinding, b: NodeBindingSnapshotBinding): number {
  return `${a.agentId}\u0000${a.nodeId}\u0000${a.kind}`.localeCompare(`${b.agentId}\u0000${b.nodeId}\u0000${b.kind}`)
}

function epochPayload(snapshot: Pick<AuthoritativeNodeBindingSnapshot, 'schemaVersion' | 'channelId' | 'sceneId' | 'sceneVersion' | 'lineId' | 'productId' | 'recipeId' | 'recipeVersion' | 'recipeHash' | 'sceneContractHash' | 'bindings'>): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    channelId: snapshot.channelId,
    sceneId: snapshot.sceneId,
    sceneVersion: snapshot.sceneVersion,
    lineId: snapshot.lineId,
    productId: snapshot.productId,
    recipeId: snapshot.recipeId,
    recipeVersion: snapshot.recipeVersion,
    recipeHash: snapshot.recipeHash,
    sceneContractHash: snapshot.sceneContractHash,
    bindings: snapshot.bindings.slice().sort(bindingSort),
  }
}

type HashableBindingSnapshot = Omit<AuthoritativeNodeBindingSnapshot, 'snapshotHash'> & { snapshotHash?: string } | ContractNodeBindingSnapshot

function canonicalBindingSnapshotPayload(snapshot: HashableBindingSnapshot): AnyRecord {
  const { snapshotHash: _snapshotHash, createdAt: _createdAt, createdBy: _createdBy, snapshotId: _snapshotId, ...payload } = snapshot as AuthoritativeNodeBindingSnapshot
  return { ...payload, bindings: payload.bindings.slice().sort(bindingSort) }
}

export function computeBindingEpoch(snapshot: Pick<AuthoritativeNodeBindingSnapshot, 'schemaVersion' | 'channelId' | 'sceneId' | 'sceneVersion' | 'lineId' | 'productId' | 'recipeId' | 'recipeVersion' | 'recipeHash' | 'sceneContractHash' | 'bindings'>): string {
  return sha256(epochPayload(snapshot))
}

export const bindingEpochHash = computeBindingEpoch

export function hashNodeBindingSnapshot(snapshot: Omit<AuthoritativeNodeBindingSnapshot, 'snapshotHash'> & { snapshotHash?: string } | ContractNodeBindingSnapshot): string {
  return sha256(canonicalBindingSnapshotPayload(snapshot))
}

export const canonicalBindingSnapshotHash = hashNodeBindingSnapshot

export function createNodeBindingSnapshot(input: NodeBindingSnapshotInput): AuthoritativeNodeBindingSnapshot {
  const channelId = text(input.channelId)
  const createdBy = text(input.createdBy)
  if (!channelId) throw new Error('BINDING_CHANNEL_REQUIRED')
  if (!createdBy) throw new Error('BINDING_CREATED_BY_REQUIRED')
  const scene = sceneOf(input)
  const sceneId = text(input.sceneId ?? sceneIdOf(scene))
  const sceneVersion = text(input.sceneVersion ?? sceneVersionOf(scene))
  const lineId = text(input.lineId ?? sceneLineIdOf(scene) ?? recipeLineIdOf(input.recipe))
  const explicitRecipeId = optionalText(input.recipeId ?? sceneRecipeIdOf(scene) ?? recipeIdOf(input.recipe))
  const explicitProductId = optionalText(input.productId ?? sceneProductIdOf(scene) ?? recipeProductIdOf(input.recipe))
  const activeRun = activeRunFor(lineId)
  const activeRecipeId = optionalText(activeRun?.recipeId)
  const activeProductId = optionalText(activeRun?.productId)
  const recipeId = explicitRecipeId ?? activeRecipeId
  const productId = explicitProductId ?? activeProductId
  const recipe = resolveRecipe(input, recipeId)
  const recipeVersion = input.recipeVersion ?? recipeVersionOf(recipe)
  const recipeHashValue = canonicalRecipeHash(recipe, input.recipeHash)
  if (!sceneId || !sceneVersion) throw new Error('BINDING_SCENE_REQUIRED')
  if (!lineId) throw new Error('BINDING_LINE_REQUIRED')
  if (input.requireFrozenScene && !isFrozenScene(scene)) throw new Error('BINDING_SCENE_NOT_FROZEN')
  if (sceneLineIdOf(scene) && sceneLineIdOf(scene) !== lineId) throw new Error('BINDING_SCENE_LINE_MISMATCH')
  if (sceneProductIdOf(scene) && sceneProductIdOf(scene) !== productId) throw new Error('BINDING_SCENE_PRODUCT_MISMATCH')
  if (sceneRecipeIdOf(scene) && sceneRecipeIdOf(scene) !== recipeId) throw new Error('BINDING_SCENE_RECIPE_MISMATCH')
  if (activeRecipeId && recipeId && activeRecipeId !== recipeId) throw new Error('BINDING_RECIPE_MISMATCH')
  if (activeProductId && productId && activeProductId !== productId) throw new Error('BINDING_PRODUCT_MISMATCH')
  const sources = input.bindings ?? input.currentBindings ?? input.agentBindings ?? input.bindingRecords ?? liveBindingSources(input)
  const bindings = sources.map(source => normalizedBinding(input, source, lineId, productId, recipeId)).sort(bindingSort)
  if (!bindings.length) throw new Error('BINDING_SNAPSHOT_EMPTY')
  const seen = new Set<string>()
  for (const binding of bindings) {
    const key = `${binding.agentId}\u0000${binding.nodeId}\u0000${binding.kind}`
    if (seen.has(key)) throw new Error(`BINDING_DUPLICATE:${binding.nodeId}`)
    seen.add(key)
    if (productId && binding.productId && binding.productId !== productId) throw new Error(`BINDING_PRODUCT_MISMATCH:${binding.nodeId}`)
    if (recipeId && binding.recipeId && binding.recipeId !== recipeId) throw new Error(`BINDING_RECIPE_MISMATCH:${binding.nodeId}`)
  }
  const sceneHash = scene ? sceneContractHash(scene) : undefined
  const base = {
    schemaVersion: 1,
    createdAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    createdBy,
    snapshotId: input.snapshotId ?? createId('binding'),
    channelId,
    sceneId,
    sceneVersion,
    lineId,
    ...(productId ? { productId } : {}),
    ...(recipeId ? { recipeId } : {}),
    ...(recipeVersion != null ? { recipeVersion } : {}),
    ...(recipeHashValue ? { recipeHash: recipeHashValue } : {}),
    ...(sceneHash ? { sceneContractHash: sceneHash } : {}),
    bindings,
  } satisfies Omit<AuthoritativeNodeBindingSnapshot, 'snapshotHash' | 'bindingEpoch'>
  const bindingEpoch = computeBindingEpoch(base)
  if (input.expectedBindingEpoch && input.expectedBindingEpoch !== bindingEpoch) throw new Error('BINDING_EPOCH_MISMATCH')
  const snapshot = { ...base, bindingEpoch, snapshotHash: hashNodeBindingSnapshot({ ...base, bindingEpoch }) }
  const verified = validateNodeBindingSnapshot(snapshot, {
    scene,
    frozenScene: input.requireFrozenScene ? scene : undefined,
    expectedChannelId: channelId,
    expectedSceneId: sceneId,
    expectedSceneVersion: sceneVersion,
    expectedLineId: lineId,
    productId,
    recipeId,
    recipeVersion,
    recipe,
    recipeHash: recipeHashValue,
    requireFrozenScene: Boolean(input.requireFrozenScene),
    requireRecipe: Boolean(recipeId || recipeHashValue),
  })
  if (!verified.valid) throw new Error(verified.errors[0] ?? 'BINDING_SNAPSHOT_INVALID')
  return snapshot
}

export const buildNodeBindingSnapshot = createNodeBindingSnapshot
export const buildBindingSnapshot = createNodeBindingSnapshot
export const createBindingSnapshot = createNodeBindingSnapshot

function validateBindingShape(snapshot: AnyRecord, errors: string[]): snapshot is AnyRecord & { bindings: unknown[] } {
  for (const key of ['createdAt', 'createdBy', 'snapshotId', 'channelId', 'bindingEpoch', 'sceneId', 'sceneVersion', 'lineId', 'snapshotHash']) {
    if (!text(snapshot[key])) errors.push(`BINDING_${key.toUpperCase()}_REQUIRED`)
  }
  if (!Number.isInteger(snapshot.schemaVersion) || Number(snapshot.schemaVersion) <= 0) errors.push('BINDING_SCHEMA_INVALID')
  if (!Number.isFinite(Date.parse(text(snapshot.createdAt)))) errors.push('BINDING_CREATED_AT_INVALID')
  if (!Array.isArray(snapshot.bindings) || snapshot.bindings.length === 0) {
    errors.push('BINDING_SNAPSHOT_EMPTY')
    return false
  }
  return true
}

function validateSceneBinding(snapshot: AnyRecord, scene: SceneContract | SceneWithDraftMetadata, errors: string[]): void {
  if (snapshot.sceneId !== scene.sceneId) errors.push('BINDING_SCENE_MISMATCH')
  if (snapshot.sceneVersion !== scene.sceneVersion) errors.push('BINDING_SCENE_VERSION_MISMATCH')
  if (snapshot.lineId !== scene.lineId) errors.push('BINDING_LINE_MISMATCH')
  if (!sameOptional(snapshot.productId, scene.productId)) errors.push('BINDING_PRODUCT_MISMATCH')
  if (!sameOptional(snapshot.recipeId, scene.recipeId)) errors.push('BINDING_RECIPE_MISMATCH')
  const actualHash = sceneContractHash(scene)
  if (snapshot.sceneContractHash !== actualHash) errors.push('BINDING_SCENE_HASH_MISMATCH')
  const variables = [
    ...(scene.controls ?? []),
    ...(scene.states ?? []),
    ...(scene.disturbances ?? []),
    ...(scene.observations ?? []),
    ...(scene.guards ?? []),
  ]
  const bindings = snapshot.bindings as Array<AnyRecord>
  for (const variable of variables) {
    const nodeId = optionalText(variable.nodeId)
    if (!nodeId) continue
    const expectedKind: BindingNodeKind = variable.role === 'control' ? 'dcw' : 'daq'
    const candidates = bindings.filter(binding => binding.nodeId === nodeId)
    if (!candidates.length) {
      errors.push(`BINDING_SCENE_NODE_MISSING:${nodeId}`)
      continue
    }
    const match = candidates.find(binding => binding.kind === expectedKind)
    if (!match) {
      errors.push(`BINDING_NODE_KIND_MISMATCH:${nodeId}`)
      continue
    }
    if (match.unit !== variable.unit) errors.push(`BINDING_UNIT_MISMATCH:${nodeId}`)
    // Descriptions may be enriched/normalized by the node catalog; nodeId, role, unit, and range are authoritative.
    // Keep physicalMeaning in the snapshot for audit, but do not reject a same-node description rewrite.
    if (variable.min != null && match.min !== variable.min) errors.push(`BINDING_MIN_MISMATCH:${nodeId}`)
    if (variable.max != null && match.max !== variable.max) errors.push(`BINDING_MAX_MISMATCH:${nodeId}`)
  }
}

function validateRecipeBinding(snapshot: AnyRecord, options: NodeBindingSnapshotVerifyOptions, errors: string[]): void {
  const recipeId = optionalText(options.recipeId ?? recipeIdOf(options.recipe))
  const productId = optionalText(options.productId ?? recipeProductIdOf(options.recipe))
  const lineId = optionalText(options.expectedLineId ?? recipeLineIdOf(options.recipe))
  const recipeVersion = options.recipeVersion ?? recipeVersionOf(options.recipe)
  const recipeHashValue = canonicalRecipeHash(options.recipe, options.recipeHash)
  if (options.requireRecipe && !recipeId) errors.push('BINDING_RECIPE_REQUIRED')
  if (recipeId && snapshot.recipeId !== recipeId) errors.push('BINDING_RECIPE_MISMATCH')
  if (productId && snapshot.productId !== productId) errors.push('BINDING_PRODUCT_MISMATCH')
  if (lineId && snapshot.lineId !== lineId) errors.push('BINDING_LINE_MISMATCH')
  if (recipeVersion != null && snapshot.recipeVersion !== recipeVersion) errors.push('BINDING_RECIPE_VERSION_MISMATCH')
  if (recipeHashValue && snapshot.recipeHash !== recipeHashValue) errors.push('BINDING_RECIPE_HASH_MISMATCH')
  if (recipeHashValue && !snapshot.recipeHash) errors.push('BINDING_RECIPE_HASH_MISSING')
}

export function validateNodeBindingSnapshot(input: unknown, options: NodeBindingSnapshotVerifyOptions = {}): BindingSnapshotValidationResult {
  const snapshot = record(input)
  if (!snapshot) return { valid: false, errors: ['BINDING_SNAPSHOT_REQUIRED'] }
  const errors: string[] = []
  if (!validateBindingShape(snapshot, errors)) return { valid: false, errors }
  const bindings = snapshot.bindings as Array<AnyRecord>
  const seen = new Set<string>()
  for (const binding of bindings) {
    const kind = text(binding.kind)
    const mode = text(binding.mode)
    const policy = text(binding.controlPolicy)
    for (const key of ['agentId', 'agentRole', 'nodeId', 'lineId', 'physicalMeaning', 'unit']) {
      if (!text(binding[key])) errors.push(`BINDING_ENTRY_${key.toUpperCase()}_REQUIRED`)
    }
    if (kind !== 'daq' && kind !== 'dcw') errors.push(`BINDING_KIND_INVALID:${binding.nodeId ?? ''}`)
    if (mode !== 'auto' && mode !== 'manual') errors.push(`BINDING_MODE_INVALID:${binding.nodeId ?? ''}`)
    if (!['recommendation_only', 'hitl_governed', 'bounded_auto'].includes(policy)) errors.push(`BINDING_POLICY_INVALID:${binding.nodeId ?? ''}`)
    if ((binding.min != null && !finite(binding.min)) || (binding.max != null && !finite(binding.max))) errors.push(`BINDING_RANGE_INVALID:${binding.nodeId ?? ''}`)
    if (binding.min != null && binding.max != null && Number(binding.min) > Number(binding.max)) errors.push(`BINDING_RANGE_ORDER:${binding.nodeId ?? ''}`)
    if (binding.samplePeriodMs != null && (!finite(binding.samplePeriodMs) || Number(binding.samplePeriodMs) <= 0)) errors.push(`BINDING_SAMPLE_PERIOD_INVALID:${binding.nodeId ?? ''}`)
    const key = `${text(binding.agentId)}\u0000${text(binding.nodeId)}\u0000${kind}`
    if (seen.has(key)) errors.push(`BINDING_DUPLICATE:${binding.nodeId ?? ''}`)
    seen.add(key)
    if (binding.lineId !== snapshot.lineId) errors.push(`BINDING_LINE_MISMATCH:${binding.nodeId ?? ''}`)
    if (snapshot.productId && binding.productId && binding.productId !== snapshot.productId) errors.push(`BINDING_PRODUCT_MISMATCH:${binding.nodeId ?? ''}`)
    if (snapshot.recipeId && binding.recipeId && binding.recipeId !== snapshot.recipeId) errors.push(`BINDING_RECIPE_MISMATCH:${binding.nodeId ?? ''}`)
  }
  let calculatedHash: string | undefined
  let calculatedBindingEpoch: string | undefined
  try {
    calculatedHash = hashNodeBindingSnapshot(snapshot as unknown as AuthoritativeNodeBindingSnapshot)
    calculatedBindingEpoch = computeBindingEpoch(snapshot as unknown as AuthoritativeNodeBindingSnapshot)
    if (snapshot.snapshotHash !== calculatedHash) errors.push('BINDING_SNAPSHOT_HASH_MISMATCH')
    if (snapshot.bindingEpoch !== calculatedBindingEpoch) errors.push('BINDING_EPOCH_MISMATCH')
  }
  catch {
    errors.push('BINDING_SNAPSHOT_HASH_INVALID')
  }
  const scene = options.frozenScene ?? options.scene
  if (options.requireFrozenScene && !scene) errors.push('BINDING_SCENE_REQUIRED')
  if (options.requireFrozenScene && scene && !isFrozenScene(scene)) errors.push('BINDING_SCENE_NOT_FROZEN')
  if (scene) validateSceneBinding(snapshot, scene, errors)
  if (options.expectedChannelId && snapshot.channelId !== options.expectedChannelId) errors.push('BINDING_CHANNEL_MISMATCH')
  if (options.expectedSceneId && snapshot.sceneId !== options.expectedSceneId) errors.push('BINDING_SCENE_MISMATCH')
  if (options.expectedSceneVersion && snapshot.sceneVersion !== options.expectedSceneVersion) errors.push('BINDING_SCENE_VERSION_MISMATCH')
  if (options.expectedLineId && snapshot.lineId !== options.expectedLineId) errors.push('BINDING_LINE_MISMATCH')
  validateRecipeBinding(snapshot, options, errors)
  const expectedHash = options.expectedSnapshotHash ?? options.expectedBindingSnapshotHash
  if (expectedHash && snapshot.snapshotHash !== expectedHash) errors.push('BINDING_SNAPSHOT_HASH_MISMATCH')
  const expectedEpoch = options.currentBindingEpoch ?? options.expectedBindingEpoch
  if (expectedEpoch && snapshot.bindingEpoch !== expectedEpoch) errors.push('BINDING_EPOCH_MISMATCH')
  if (options.currentSnapshot != null) {
    const current = record(options.currentSnapshot)
    if (!current) errors.push('BINDING_CURRENT_SNAPSHOT_INVALID')
    else if (text(current.bindingEpoch) !== text(snapshot.bindingEpoch)) errors.push('BINDING_EPOCH_MISMATCH')
  }
  if (options.maxAgeMs != null) {
    const nowMs = options.nowMs ?? Date.now()
    const age = nowMs - Date.parse(text(snapshot.createdAt))
    if (age < 0) errors.push('BINDING_SNAPSHOT_FUTURE')
    else if (age > options.maxAgeMs) errors.push('BINDING_SNAPSHOT_EXPIRED')
  }
  return { valid: errors.length === 0, errors, calculatedHash, calculatedBindingEpoch }
}

function verifyOptions(options: NodeBindingSnapshotVerifyOptions | string | undefined): NodeBindingSnapshotVerifyOptions {
  return typeof options === 'string' ? { expectedSnapshotHash: options } : options ?? {}
}

export function verifyNodeBindingSnapshot(snapshot: unknown, options?: NodeBindingSnapshotVerifyOptions | string): boolean {
  return validateNodeBindingSnapshot(snapshot, verifyOptions(options)).valid
}

export function assertNodeBindingSnapshot(snapshot: unknown, options?: NodeBindingSnapshotVerifyOptions | string): asserts snapshot is AuthoritativeNodeBindingSnapshot {
  const result = validateNodeBindingSnapshot(snapshot, verifyOptions(options))
  if (!result.valid) throw new Error(result.errors[0] ?? 'BINDING_SNAPSHOT_INVALID')
}

export const validateBindingSnapshot = validateNodeBindingSnapshot
export const verifyBindingSnapshot = verifyNodeBindingSnapshot
export const assertBindingSnapshot = assertNodeBindingSnapshot
export const bindingSnapshotHash = hashNodeBindingSnapshot
