import { createId, sha256, type NodeBindingSnapshot as ContractNodeBindingSnapshot, type SceneContract, type TwinSnapshot } from './contracts'
import {
  canonicalRecipeHash,
  validateNodeBindingSnapshot,
  type AuthoritativeNodeBindingSnapshot,
  type NodeBindingSnapshotVerifyOptions,
} from './binding-snapshot'
import { sceneContractHash, type SceneWithDraftMetadata } from './scene-lifecycle'

export interface DaqSample {
  nodeId: string
  at: number
  value: number
  sequence?: string | number
  lineId?: string
  productId?: string
  recipeId?: string
}

export type SnapshotScene = SceneContract | SceneWithDraftMetadata
export type SnapshotBinding = ContractNodeBindingSnapshot | AuthoritativeNodeBindingSnapshot
export type AuthoritativeTwinSnapshot = TwinSnapshot & {
  channelId?: string
  sceneContractHash?: string
  bindingEpoch?: string
  recipeVersion?: string | number
  recipeHash?: string
}

export interface SnapshotInput {
  scene: SnapshotScene
  channelId: string
  createdBy: string
  phase: string
  controls: Record<string, number>
  states?: Record<string, number>
  disturbances?: Record<string, number>
  samples: DaqSample[]
  bindingSnapshot?: SnapshotBinding
  bindingSnapshotHash?: string
  frozenScene?: SnapshotScene
  recipe?: unknown
  recipeVersion?: string | number
  recipeHash?: string
  physicsModelVersion?: string
  residualModelVersion?: string
  nowMs?: number
  freshnessMaxMs?: number
  /** Enable fail-closed P0 checks while preserving the old legacy path by default. */
  strict?: boolean
  requireBindingSnapshot?: boolean
  requireFrozenScene?: boolean
}

export interface TwinSnapshotValidationOptions {
  scene?: SnapshotScene
  frozenScene?: SnapshotScene
  bindingSnapshot?: SnapshotBinding
  expectedBindingSnapshotHash?: string
  expectedBindingEpoch?: string
  channelId?: string
  recipe?: unknown
  recipeVersion?: string | number
  recipeHash?: string
  expectedLineId?: string
  expectedProductId?: string
  expectedRecipeId?: string
  nowMs?: number
  maxAgeMs?: number
  requireFresh?: boolean
  requireBindingSnapshot?: boolean
  requireFrozenScene?: boolean
  requireRecipe?: boolean
}

export interface TwinSnapshotValidationResult {
  valid: boolean
  errors: string[]
  calculatedHash?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value)
  return valueText || undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sceneIsFrozen(scene: unknown): boolean {
  const value = record(scene)
  if (!value) return false
  return value.status === 'frozen' || record(value.draftMeta)?.status === 'frozen'
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

function recipeVersionOf(recipe: unknown): string | number | undefined {
  const value = record(recipe)?.version ?? record(recipe)?.recipeVersion
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function recipeProductIdOf(recipe: unknown): string | undefined {
  return optionalText(record(recipe)?.productId)
}

function recipeLineIdOf(recipe: unknown): string | undefined {
  return optionalText(record(recipe)?.lineId)
}

function recipeContext(input: Pick<SnapshotInput, 'scene' | 'recipe' | 'recipeVersion' | 'recipeHash'>): {
  lineId: string
  productId?: string
  recipeId?: string
  recipeVersion?: string | number
  recipeHash?: string
} {
  const scene = input.scene
  const recipeId = recipeIdOf(input.recipe) ?? sceneRecipeIdOf(scene)
  const productId = recipeProductIdOf(input.recipe) ?? sceneProductIdOf(scene)
  const lineId = recipeLineIdOf(input.recipe) ?? sceneLineIdOf(scene) ?? ''
  const recipeVersion = input.recipeVersion ?? recipeVersionOf(input.recipe)
  const recipeHash = canonicalRecipeHash(input.recipe, input.recipeHash)
  if (!lineId) throw new Error('SNAPSHOT_LINE_REQUIRED')
  if (sceneLineIdOf(scene) && sceneLineIdOf(scene) !== lineId) throw new Error('SNAPSHOT_LINE_MISMATCH')
  if (sceneProductIdOf(scene) && productId && sceneProductIdOf(scene) !== productId) throw new Error('SNAPSHOT_PRODUCT_MISMATCH')
  if (sceneRecipeIdOf(scene) && recipeId && sceneRecipeIdOf(scene) !== recipeId) throw new Error('SNAPSHOT_RECIPE_MISMATCH')
  return { lineId, ...(productId ? { productId } : {}), ...(recipeId ? { recipeId } : {}), ...(recipeVersion != null ? { recipeVersion } : {}), ...(recipeHash ? { recipeHash } : {}) }
}

function snapshotHashPayload(snapshot: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'snapshotHash'))
}

export function hashTwinSnapshot(snapshot: TwinSnapshot | AuthoritativeTwinSnapshot): string {
  return sha256(snapshotHashPayload(snapshot as unknown as Record<string, unknown>))
}

export const canonicalTwinSnapshotHash = hashTwinSnapshot

function bindingVerificationOptions(input: SnapshotInput, context: ReturnType<typeof recipeContext>): NodeBindingSnapshotVerifyOptions {
  return {
    scene: input.frozenScene ?? input.scene,
    frozenScene: input.frozenScene,
    expectedChannelId: input.channelId,
    expectedSceneId: input.scene.sceneId,
    expectedSceneVersion: input.scene.sceneVersion,
    expectedLineId: context.lineId,
    productId: context.productId,
    recipeId: context.recipeId,
    recipeVersion: context.recipeVersion,
    recipe: input.recipe,
    recipeHash: context.recipeHash,
    expectedSnapshotHash: input.bindingSnapshotHash,
    requireFrozenScene: Boolean(input.requireFrozenScene || input.frozenScene),
    requireRecipe: Boolean(input.recipe || context.recipeId || context.recipeHash),
  }
}

function assertBindingForSnapshot(input: SnapshotInput, context: ReturnType<typeof recipeContext>, strict: boolean): SnapshotBinding | undefined {
  const binding = input.bindingSnapshot
  const mustHaveBinding = input.requireBindingSnapshot ?? strict
  if (!binding) {
    if (mustHaveBinding) throw new Error('SNAPSHOT_BINDING_REQUIRED')
    if (input.bindingSnapshotHash) throw new Error('SNAPSHOT_BINDING_REQUIRED')
    return undefined
  }
  const check = validateNodeBindingSnapshot(binding, bindingVerificationOptions(input, context))
  if (!check.valid) throw new Error(check.errors[0] ?? 'SNAPSHOT_BINDING_INVALID')
  if (input.bindingSnapshotHash && binding.snapshotHash !== input.bindingSnapshotHash) throw new Error('SNAPSHOT_BINDING_HASH_MISMATCH')
  return binding
}

function sampleIdentity(sample: DaqSample): string {
  return `${sample.nodeId}\u0000${sample.at}\u0000${sample.sequence == null ? '' : String(sample.sequence)}`
}

function validateSamples(samples: DaqSample[], input: SnapshotInput, context: ReturnType<typeof recipeContext>, strict: boolean): DaqSample[] {
  const accepted: DaqSample[] = []
  const seenSampleIds = new Set<string>()
  const lastAtByNode = new Map<string, number>()
  const lastSequenceByNode = new Map<string, string>()
  const recipeIds = new Set<string>()
  const productIds = new Set<string>()
  const lineIds = new Set<string>()
  for (const sample of samples) {
    const validShape = Boolean(sample && text(sample.nodeId) && finite(sample.at) && finite(sample.value))
    if (!validShape) {
      if (strict) throw new Error('SNAPSHOT_SAMPLE_INVALID')
      continue
    }
    const nodeId = text(sample.nodeId)
    const normalized = { ...sample, nodeId }
    if (sample.recipeId) recipeIds.add(text(sample.recipeId))
    if (sample.productId) productIds.add(text(sample.productId))
    if (sample.lineId) lineIds.add(text(sample.lineId))
    const previousAt = lastAtByNode.get(nodeId)
    const sequence = sample.sequence == null ? undefined : String(sample.sequence)
    const previousSequence = lastSequenceByNode.get(nodeId)
    const duplicate = previousAt === sample.at || (sequence != null && previousSequence === sequence) || seenSampleIds.has(sampleIdentity(sample))
    const outOfOrder = previousAt != null && sample.at < previousAt
    if (strict && duplicate) throw new Error('SNAPSHOT_DUPLICATE_SAMPLE')
    if (strict && outOfOrder) throw new Error('SNAPSHOT_SAMPLE_OUT_OF_ORDER')
    if (strict && sample.at > (input.nowMs ?? Date.now())) throw new Error('SNAPSHOT_SAMPLE_FUTURE')
    if (sample.lineId && text(sample.lineId) !== context.lineId) throw new Error('SNAPSHOT_LINE_MISMATCH')
    if (sample.productId && context.productId && text(sample.productId) !== context.productId) throw new Error('SNAPSHOT_PRODUCT_MISMATCH')
    if (sample.recipeId && context.recipeId && text(sample.recipeId) !== context.recipeId) throw new Error('SNAPSHOT_CROSS_RECIPE')
    if (sample.recipeId && !context.recipeId && recipeIds.size > 1) throw new Error('SNAPSHOT_CROSS_RECIPE')
    lastAtByNode.set(nodeId, sample.at)
    if (sequence != null) lastSequenceByNode.set(nodeId, sequence)
    seenSampleIds.add(sampleIdentity(sample))
    accepted.push(normalized)
  }
  if (strict && recipeIds.size > 1) throw new Error('SNAPSHOT_CROSS_RECIPE')
  if (strict && productIds.size > 1) throw new Error('SNAPSHOT_CROSS_PRODUCT')
  if (strict && lineIds.size > 1) throw new Error('SNAPSHOT_CROSS_LINE')
  return accepted
}

function requiredNodeIds(scene: SnapshotScene): string[] {
  return [...scene.observations, ...scene.states]
    .map(variable => variable.nodeId)
    .filter((nodeId): nodeId is string => Boolean(nodeId))
}

function assertStrictQuality(staleNodeIds: string[], completeness: number, duplicateCount: number, watermark: number, phase: string, scene: SnapshotScene): void {
  if (!phase.trim()) throw new Error('SNAPSHOT_PHASE_REQUIRED')
  if (Array.isArray(scene.phases) && scene.phases.length > 0 && !scene.phases.includes(phase)) throw new Error('SNAPSHOT_PHASE_INVALID')
  if (!watermark) throw new Error('SNAPSHOT_MISSING_DATA')
  if (staleNodeIds.length) throw new Error('SNAPSHOT_STALE')
  if (completeness < 1) throw new Error('SNAPSHOT_INCOMPLETE')
  if (duplicateCount > 0) throw new Error('SNAPSHOT_DUPLICATE_SAMPLE')
}

export function createTwinSnapshot(input: SnapshotInput): TwinSnapshot {
  const now = input.nowMs ?? Date.now()
  const freshnessMaxMs = input.freshnessMaxMs ?? 60_000
  const strict = Boolean(input.strict || input.bindingSnapshot || input.bindingSnapshotHash || input.frozenScene || input.recipe || input.recipeHash || input.requireBindingSnapshot || input.requireFrozenScene)
  if (!input.channelId.trim()) throw new Error('SNAPSHOT_CHANNEL_REQUIRED')
  if (!input.createdBy.trim()) throw new Error('SNAPSHOT_CREATED_BY_REQUIRED')
  const context = recipeContext(input)
  if (input.frozenScene && !sceneIsFrozen(input.frozenScene)) throw new Error('SNAPSHOT_SCENE_NOT_FROZEN')
  if (input.requireFrozenScene && !sceneIsFrozen(input.frozenScene ?? input.scene)) throw new Error('SNAPSHOT_SCENE_NOT_FROZEN')
  const binding = assertBindingForSnapshot(input, context, strict)
  const samples = validateSamples(input.samples, input, context, strict)
  const byNode = new Map<string, DaqSample[]>()
  for (const sample of samples) {
    const list = byNode.get(sample.nodeId) ?? []
    list.push(sample)
    byNode.set(sample.nodeId, list)
  }
  const staleNodeIds: string[] = []
  let watermark = 0
  let duplicateCount = 0
  const required = requiredNodeIds(input.scene)
  for (const nodeId of required) {
    const nodeSamples = byNode.get(nodeId) ?? []
    const sorted = [...nodeSamples].sort((a, b) => a.at - b.at)
    const latest = sorted.at(-1)
    if (!latest) {
      staleNodeIds.push(nodeId)
      continue
    }
    watermark = Math.max(watermark, latest.at)
    const seenTimes = new Set<number>()
    for (const sample of nodeSamples) {
      if (seenTimes.has(sample.at)) duplicateCount++
      seenTimes.add(sample.at)
    }
    if (now - latest.at > freshnessMaxMs) staleNodeIds.push(nodeId)
  }
  const totalRequired = Math.max(1, required.length)
  const completeness = (totalRequired - staleNodeIds.length) / totalRequired
  if (strict) assertStrictQuality(staleNodeIds, completeness, duplicateCount, watermark, input.phase, input.scene)
  const sceneHash = input.frozenScene ? sceneContractHash(input.frozenScene) : undefined
  const snapshotBase: Record<string, unknown> = {
    schemaVersion: 1,
    createdAt: new Date(now).toISOString(),
    createdBy: input.createdBy,
    snapshotId: createId('snap'),
    channelId: input.channelId,
    sceneId: input.scene.sceneId,
    sceneVersion: input.scene.sceneVersion,
    sceneContractHash: sceneHash,
    lineId: context.lineId,
    productId: context.productId,
    recipeId: context.recipeId,
    recipeVersion: context.recipeVersion,
    recipeHash: context.recipeHash,
    phase: input.phase,
    capturedAt: new Date(watermark || now).toISOString(),
    daqWatermark: watermark,
    sourceSequence: samples.map(sample => sample.sequence).filter(value => value != null).map(String).at(-1),
    controlValues: input.controls,
    stateEstimate: input.states ?? {},
    disturbances: input.disturbances ?? {},
    dataQuality: { fresh: staleNodeIds.length === 0 && watermark > 0, completeness, staleNodeIds, duplicateCount },
    estimatorVersion: 'raw-last-observation-v1',
    bindingSnapshotHash: binding?.snapshotHash,
    bindingEpoch: binding?.bindingEpoch,
    physicsModelVersion: input.physicsModelVersion,
    residualModelVersion: input.residualModelVersion,
  }
  const snapshot = { ...snapshotBase, snapshotHash: sha256(snapshotBase) } as AuthoritativeTwinSnapshot
  if (strict) {
    const verified = validateTwinSnapshot(snapshot, {
      scene: input.scene,
      frozenScene: input.frozenScene,
      bindingSnapshot: binding,
      expectedBindingSnapshotHash: input.bindingSnapshotHash,
      expectedBindingEpoch: binding?.bindingEpoch,
      channelId: input.channelId,
      recipe: input.recipe,
      recipeVersion: context.recipeVersion,
      recipeHash: context.recipeHash,
      expectedLineId: context.lineId,
      expectedProductId: context.productId,
      expectedRecipeId: context.recipeId,
      nowMs: now,
      maxAgeMs: freshnessMaxMs,
      requireFresh: true,
      requireBindingSnapshot: true,
      requireFrozenScene: Boolean(input.requireFrozenScene || input.frozenScene),
      requireRecipe: Boolean(input.recipe || context.recipeId || context.recipeHash),
    })
    if (!verified.valid) throw new Error(verified.errors[0] ?? 'SNAPSHOT_INVALID')
  }
  return snapshot
}

export function validateTwinSnapshot(input: unknown, options: TwinSnapshotValidationOptions = {}): TwinSnapshotValidationResult {
  const snapshot = record(input)
  if (!snapshot) return { valid: false, errors: ['SNAPSHOT_REQUIRED'] }
  const errors: string[] = []
  for (const key of ['createdAt', 'createdBy', 'snapshotId', 'sceneId', 'sceneVersion', 'lineId', 'phase', 'capturedAt', 'snapshotHash']) {
    if (!text(snapshot[key])) errors.push(`SNAPSHOT_${key.toUpperCase()}_REQUIRED`)
  }
  if (!Number.isInteger(snapshot.schemaVersion) || Number(snapshot.schemaVersion) <= 0) errors.push('SNAPSHOT_SCHEMA_INVALID')
  if (!finite(snapshot.daqWatermark)) errors.push('SNAPSHOT_WATERMARK_INVALID')
  if (!record(snapshot.dataQuality)) errors.push('SNAPSHOT_QUALITY_REQUIRED')
  const dataQuality = record(snapshot.dataQuality)
  if (dataQuality && typeof dataQuality.fresh !== 'boolean') errors.push('SNAPSHOT_QUALITY_INVALID')
  const calculatedHash = hashTwinSnapshot(snapshot as unknown as AuthoritativeTwinSnapshot)
  if (snapshot.snapshotHash !== calculatedHash) errors.push('SNAPSHOT_HASH_MISMATCH')
  const scene = options.frozenScene ?? options.scene
  if (options.requireFrozenScene && !scene) errors.push('SNAPSHOT_SCENE_REQUIRED')
  if (options.requireFrozenScene && scene && !sceneIsFrozen(scene)) errors.push('SNAPSHOT_SCENE_NOT_FROZEN')
  if (scene) {
    if (snapshot.sceneId !== scene.sceneId) errors.push('SNAPSHOT_SCENE_MISMATCH')
    if (snapshot.sceneVersion !== scene.sceneVersion) errors.push('SNAPSHOT_SCENE_VERSION_MISMATCH')
    if (snapshot.lineId !== scene.lineId) errors.push('SNAPSHOT_LINE_MISMATCH')
    if (snapshot.productId !== scene.productId) errors.push('SNAPSHOT_PRODUCT_MISMATCH')
    if (snapshot.recipeId !== scene.recipeId) errors.push('SNAPSHOT_RECIPE_MISMATCH')
    if (options.frozenScene && snapshot.sceneContractHash !== sceneContractHash(options.frozenScene)) errors.push('SNAPSHOT_SCENE_HASH_MISMATCH')
  }
  if (options.channelId && snapshot.channelId !== options.channelId) errors.push('SNAPSHOT_CHANNEL_MISMATCH')
  if (options.expectedLineId && snapshot.lineId !== options.expectedLineId) errors.push('SNAPSHOT_LINE_MISMATCH')
  if (options.expectedProductId && snapshot.productId !== options.expectedProductId) errors.push('SNAPSHOT_PRODUCT_MISMATCH')
  if (options.expectedRecipeId && snapshot.recipeId !== options.expectedRecipeId) errors.push('SNAPSHOT_RECIPE_MISMATCH')
  const recipeId = recipeIdOf(options.recipe)
  const productId = recipeProductIdOf(options.recipe)
  const lineId = recipeLineIdOf(options.recipe)
  const recipeVersion = options.recipeVersion ?? recipeVersionOf(options.recipe)
  const recipeHash = canonicalRecipeHash(options.recipe, options.recipeHash)
  if (options.requireRecipe && !recipeId && !options.expectedRecipeId) errors.push('SNAPSHOT_RECIPE_REQUIRED')
  if (recipeId && snapshot.recipeId !== recipeId) errors.push('SNAPSHOT_RECIPE_MISMATCH')
  if (productId && snapshot.productId !== productId) errors.push('SNAPSHOT_PRODUCT_MISMATCH')
  if (lineId && snapshot.lineId !== lineId) errors.push('SNAPSHOT_LINE_MISMATCH')
  if (recipeVersion != null && snapshot.recipeVersion !== recipeVersion) errors.push('SNAPSHOT_RECIPE_VERSION_MISMATCH')
  if (recipeHash && snapshot.recipeHash !== recipeHash) errors.push('SNAPSHOT_RECIPE_HASH_MISMATCH')
  const binding = options.bindingSnapshot
  if (options.requireBindingSnapshot && !binding) errors.push('SNAPSHOT_BINDING_REQUIRED')
  if (binding) {
    const bindingCheck = validateNodeBindingSnapshot(binding, {
      scene: options.frozenScene ?? options.scene,
      frozenScene: options.frozenScene,
      expectedChannelId: options.channelId,
      expectedSceneId: text(snapshot.sceneId),
      expectedSceneVersion: text(snapshot.sceneVersion),
      expectedLineId: text(snapshot.lineId),
      productId: optionalText(snapshot.productId),
      recipeId: optionalText(snapshot.recipeId),
      recipeVersion: snapshot.recipeVersion as string | number | undefined,
      recipe: options.recipe,
      recipeHash: options.recipeHash ?? optionalText((snapshot as Record<string, unknown>).recipeHash),
      requireFrozenScene: Boolean(options.requireFrozenScene || options.frozenScene),
      requireRecipe: Boolean(options.requireRecipe || snapshot.recipeId || (snapshot as Record<string, unknown>).recipeHash),
    })
    if (!bindingCheck.valid) errors.push(...bindingCheck.errors.map(error => `BINDING:${error}`))
    if (snapshot.bindingSnapshotHash !== binding.snapshotHash) errors.push('SNAPSHOT_BINDING_HASH_MISMATCH')
    if (snapshot.bindingEpoch !== binding.bindingEpoch) errors.push('SNAPSHOT_BINDING_EPOCH_MISMATCH')
  }
  if (options.expectedBindingSnapshotHash && snapshot.bindingSnapshotHash !== options.expectedBindingSnapshotHash) errors.push('SNAPSHOT_BINDING_HASH_MISMATCH')
  if (options.expectedBindingEpoch && snapshot.bindingEpoch !== options.expectedBindingEpoch) errors.push('SNAPSHOT_BINDING_EPOCH_MISMATCH')
  if (options.requireFresh) {
    if (!dataQuality || dataQuality.fresh !== true || Number(snapshot.daqWatermark) <= 0) errors.push('SNAPSHOT_STALE')
    if (dataQuality && Number(dataQuality.completeness) < 1) errors.push('SNAPSHOT_INCOMPLETE')
    if (dataQuality && Number(dataQuality.duplicateCount ?? 0) > 0) errors.push('SNAPSHOT_DUPLICATE_SAMPLE')
    if (dataQuality && Array.isArray(dataQuality.staleNodeIds) && dataQuality.staleNodeIds.length > 0) errors.push('SNAPSHOT_STALE')
  }
  if (options.maxAgeMs != null) {
    const nowMs = options.nowMs ?? Date.now()
    if (nowMs - Number(snapshot.daqWatermark) > options.maxAgeMs) errors.push('SNAPSHOT_STALE')
  }
  return { valid: errors.length === 0, errors, calculatedHash }
}

export function verifyTwinSnapshot(snapshot: unknown, options?: TwinSnapshotValidationOptions): boolean {
  return validateTwinSnapshot(snapshot, options).valid
}

export function assertTwinSnapshot(snapshot: unknown, options?: TwinSnapshotValidationOptions): asserts snapshot is AuthoritativeTwinSnapshot {
  const result = validateTwinSnapshot(snapshot, options)
  if (!result.valid) throw new Error(result.errors[0] ?? 'SNAPSHOT_INVALID')
}

export function assertFreshSnapshot(snapshot: TwinSnapshot, nowMs = Date.now(), maxAgeMs = 60_000, options: Omit<TwinSnapshotValidationOptions, 'nowMs' | 'maxAgeMs' | 'requireFresh'> = {}): void {
  if (!snapshot.dataQuality.fresh || snapshot.daqWatermark <= 0) throw new Error('SNAPSHOT_STALE')
  if (nowMs - snapshot.daqWatermark > maxAgeMs) throw new Error('SNAPSHOT_STALE')
  if (snapshot.dataQuality.completeness < 1) throw new Error('SNAPSHOT_INCOMPLETE')
  const authorityCheck = Boolean(options.bindingSnapshot || options.expectedBindingSnapshotHash || options.expectedBindingEpoch || options.scene || options.frozenScene || options.recipe || options.recipeHash || options.requireBindingSnapshot || options.requireFrozenScene)
  if (!authorityCheck && !snapshot.bindingSnapshotHash) return
  const result = validateTwinSnapshot(snapshot, { ...options, nowMs, maxAgeMs, requireFresh: true })
  if (!result.valid) {
    const first = result.errors.find(error => error === 'SNAPSHOT_STALE' || error === 'SNAPSHOT_INCOMPLETE') ?? result.errors[0]
    if (first) throw new Error(first)
  }
}
