import { sha256, type PhysicsModelManifest, type ObjectiveProfile } from './contracts'
import { checkProviderHealth as probeProviderHealth, normalizeProviderHealth, providerHealthAllowsUse } from './provider-health'
import { TWIN_PROVIDER_API_VERSION } from './provider-contracts'
import type {
  ArtifactContract,
  LegacyPhysicsProvider,
  ParameterPriorMap,
  PhysicsProviderManifest,
  ProviderHealth,
  ProviderLifecycleState,
  ProviderManifestAccessor,
  ProviderValidationResult,
  ScenePack,
  SolverAdapter,
  SolverAdapterManifest,
  TwinPhysicsProvider,
  TwinPluginContribution,
  TwinProviderDrainResult,
  TwinProviderFilter,
  TwinProviderLease,
  TwinProviderRegistrationResult,
  TwinProviderRetireResult,
  TwinProviderSummary,
  TwinProviderUnregistrationResult,
  TwinRegistrationSource,
  UniversalPhysicsProvider,
  VariableSpec,
} from './provider-contracts'

export interface ResolveProviderOptions {
  generation?: number
  allowDraining?: boolean
  includeFailed?: boolean
}

export interface TwinProviderGenerationSummary {
  pluginName: string
  pluginVersion?: string
  generation: number
  state: ProviderLifecycleState
  providerIds: string[]
  inFlight: number
  registeredAt: string
  drainingAt?: string
  retiredAt?: string
}

export class TwinProviderRegistryError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'TwinProviderRegistryError'
    this.code = code
    this.details = details
  }
}

interface ProviderRecord {
  provider: TwinPhysicsProvider
  manifest: PhysicsProviderManifest
  providerHash: string
  pluginName: string
  pluginVersion?: string
  generation: number
  state: ProviderLifecycleState
  health: ProviderHealth
  inFlight: number
  registeredAt: string
  drainingAt?: string
  retiredAt?: string
}

interface GenerationRecord {
  pluginName: string
  pluginVersion?: string
  generation: number
  state: ProviderLifecycleState
  registeredAt: string
  drainingAt?: string
  retiredAt?: string
  providers: Map<string, ProviderRecord>
  scenePacks: Map<string, ScenePack>
  solverAdapters: Map<string, SolverAdapter>
}

interface NormalizedSource { pluginName: string, pluginVersion?: string, source?: string }
interface StagedProvider { provider: TwinPhysicsProvider, manifest: PhysicsProviderManifest, providerHash: string, key: string }
interface StagedContribution {
  providers: StagedProvider[]
  scenePacks: Array<{ pack: ScenePack, key: string }>
  solverAdapters: Array<{ adapter: SolverAdapter, manifest: SolverAdapterManifest, key: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.trim() ? value.trim() : fallback }
function number(value: unknown): number | undefined { return Number.isFinite(Number(value)) ? Number(value) : undefined }
function key(id: string, version: string): string { return `${id}@${version}` }
function generationKey(pluginName: string, generation: number): string { return `${pluginName}\u0000${generation}` }
function readAccessor(value: unknown): unknown { return typeof value === 'function' ? (value as () => unknown)() : value }

function variables(value: unknown, fallback: unknown[] = []): VariableSpec[] {
  const result: Array<VariableSpec | null> = []
  for (const raw of (Array.isArray(value) ? value : fallback)) {
    if (typeof raw === 'string') { result.push({ id: raw }); continue }
    if (!isRecord(raw)) { result.push(null); continue }
    const id = text(raw.id ?? raw.name)
    result.push(id ? {
      id,
      unit: typeof raw.unit === 'string' ? raw.unit : undefined,
      role: typeof raw.role === 'string' ? raw.role : undefined,
      physicalMeaning: typeof raw.physicalMeaning === 'string' ? raw.physicalMeaning : undefined,
      min: number(raw.min), max: number(raw.max), maxStep: number(raw.maxStep),
      samplingPeriodMs: number(raw.samplingPeriodMs),
      metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    } : null)
  }
  return result.filter((value): value is VariableSpec => value !== null)
}

function priors(value: unknown, parameters: unknown): ParameterPriorMap {
  const source = isRecord(value) ? value : isRecord(parameters) ? parameters : {}
  const result: ParameterPriorMap = {}
  for (const [id, raw] of Object.entries(source)) {
    if (!isRecord(raw)) continue
    const min = number(raw.min); const max = number(raw.max)
    if (min == null || max == null || min > max) continue
    result[id] = { min, max, unit: typeof raw.unit === 'string' ? raw.unit : undefined, distribution: typeof raw.distribution === 'string' ? raw.distribution : undefined, metadata: isRecord(raw.metadata) ? raw.metadata : undefined }
  }
  return result
}

function backend(value: unknown): PhysicsProviderManifest['backend'] {
  const valueText = String(value ?? 'typescript')
  return ['typescript', 'python', 'onnx', 'rom', 'external-solver', 'pytorch'].includes(valueText)
    ? valueText as PhysicsProviderManifest['backend'] : 'external-solver'
}

function capabilities(provider: TwinPhysicsProvider, raw: Record<string, unknown>): PhysicsProviderManifest['capabilities'] {
  const value = isRecord(raw.capabilities) ? raw.capabilities : {}
  return {
    onlineStep: typeof provider.step === 'function' && value.onlineStep !== false,
    rollout: typeof provider.simulate === 'function' && value.rollout !== false,
    calibration: typeof (provider as UniversalPhysicsProvider).calibrate === 'function' || value.calibration === true,
    uncertainty: typeof (provider as UniversalPhysicsProvider).estimateUncertainty === 'function' || value.uncertainty === true,
    externalSolver: value.externalSolver === true,
    mpc: value.mpc === true,
  }
}

function artifactContract(raw: Record<string, unknown>): ArtifactContract {
  const value = isRecord(raw.artifactContract) ? raw.artifactContract : {}
  return {
    schemaVersion: typeof value.schemaVersion === 'string' || typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
    requiredArtifacts: Array.isArray(value.requiredArtifacts) ? value.requiredArtifacts.map(String) : [],
    optionalArtifacts: Array.isArray(value.optionalArtifacts) ? value.optionalArtifacts.map(String) : [],
    formats: isRecord(value.formats) ? Object.fromEntries(Object.entries(value.formats).map(([id, format]) => [id, String(format)])) : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  }
}

/** Normalise UniversalPhysicsProvider and the current PhysicsModelProvider shape. */
export function normalizeProviderManifest(provider: TwinPhysicsProvider): PhysicsProviderManifest {
  const raw = readAccessor((provider as unknown as { manifest?: unknown }).manifest)
  if (!isRecord(raw)) throw new TwinProviderRegistryError('PROVIDER_MANIFEST_INVALID', 'Provider manifest must be an object')
  const legacyId = text(raw.physicsModelId)
  const providerId = text(raw.providerId ?? raw.id ?? legacyId)
  const version = text(raw.version)
  if (!providerId) throw new TwinProviderRegistryError('PROVIDER_ID_MISSING', 'Provider manifest.providerId is required')
  if (!version) throw new TwinProviderRegistryError('PROVIDER_VERSION_MISSING', `Provider ${providerId} manifest.version is required`)
  const sceneId = text(raw.sceneId)
  const sceneKinds = (Array.isArray(raw.sceneKinds) ? raw.sceneKinds : sceneId ? [sceneId] : []).map(String).map(value => value.trim()).filter(Boolean)
  if (!sceneKinds.length) throw new TwinProviderRegistryError('PROVIDER_SCENE_KIND_MISSING', `Provider ${providerId}@${version} must declare sceneKinds`)
  const apiVersion = text(raw.apiVersion, TWIN_PROVIDER_API_VERSION)
  if (apiVersion !== TWIN_PROVIDER_API_VERSION) throw new TwinProviderRegistryError('PROVIDER_API_VERSION_UNSUPPORTED', `Provider ${providerId}@${version} uses unsupported apiVersion=${apiVersion}`)
  return {
    providerId, version, apiVersion: TWIN_PROVIDER_API_VERSION, sceneKinds,
    backend: backend(raw.backend),
    stateVariables: variables(raw.stateVariables),
    controlVariables: variables(raw.controlVariables),
    disturbanceVariables: variables(raw.disturbanceVariables),
    observationVariables: variables(raw.observationVariables ?? raw.observations),
    parameterPriors: priors(raw.parameterPriors, raw.parameters),
    capabilities: capabilities(provider, raw),
    artifactContract: artifactContract(raw),
    displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : undefined,
    sourceHash: typeof raw.sourceHash === 'string' ? raw.sourceHash : undefined,
    artifactHash: typeof raw.artifactHash === 'string' ? raw.artifactHash : undefined,
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
  }
}

export function providerHashOf(providerOrManifest: TwinPhysicsProvider | PhysicsProviderManifest): string {
  const value = isRecord(providerOrManifest) && 'providerId' in providerOrManifest
    ? providerOrManifest as PhysicsProviderManifest : normalizeProviderManifest(providerOrManifest as TwinPhysicsProvider)
  return sha256(value)
}

export function validateProviderDefinition(provider: TwinPhysicsProvider): ProviderValidationResult {
  const errors: string[] = []; const warnings: string[] = []
  try {
    const manifest = normalizeProviderManifest(provider)
    for (const method of ['initialize', 'step', 'simulate', 'evaluateConstraints'] as const) {
      if (typeof (provider as unknown as Record<string, unknown>)[method] !== 'function') errors.push(`missing method: ${method}`)
    }
    if (typeof (provider as UniversalPhysicsProvider).validateScene !== 'function') warnings.push('provider does not expose validateScene; registry keeps structural validation only')
    return { valid: errors.length === 0, errors, warnings, manifest, providerHash: providerHashOf(manifest) }
  }
  catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return { valid: false, errors, warnings }
  }
}

function sourceOf(pluginName: string, source?: TwinRegistrationSource): NormalizedSource {
  if (source && typeof source === 'object') return { pluginName: text(source.pluginName, pluginName), pluginVersion: source.pluginVersion, source: source.source }
  return { pluginName: text(pluginName, typeof source === 'string' ? source : 'core'), source: typeof source === 'string' ? source : undefined }
}
function solverManifest(adapter: SolverAdapter): SolverAdapterManifest {
  const raw = readAccessor((adapter as unknown as { manifest?: unknown }).manifest)
  if (!isRecord(raw)) throw new TwinProviderRegistryError('SOLVER_MANIFEST_INVALID', 'Solver adapter manifest must be an object')
  const adapterId = text(raw.adapterId ?? raw.id ?? raw.name)
  const version = text(raw.version, '0.0.0')
  if (!adapterId) throw new TwinProviderRegistryError('SOLVER_ADAPTER_ID_MISSING', 'Solver adapter manifest.adapterId is required')
  if (typeof adapter.solve !== 'function') throw new TwinProviderRegistryError('SOLVER_ADAPTER_INVALID', `Solver adapter ${adapterId}@${version} must expose solve()`)
  return { adapterId, version, backend: typeof raw.backend === 'string' ? raw.backend : undefined, capabilities: isRecord(raw.capabilities) ? {
    synchronous: raw.capabilities.synchronous === true,
    asynchronous: raw.capabilities.asynchronous !== false,
    cancellation: raw.capabilities.cancellation === true,
    artifacts: raw.capabilities.artifacts === true,
  } : undefined, metadata: isRecord(raw.metadata) ? raw.metadata : undefined }
}

function stageContribution(contribution: TwinPluginContribution): StagedContribution {
  const providers = [...(contribution.providers ?? []), ...(contribution.physicsProviders ?? [])]
  const stagedProviders: StagedProvider[] = []; const providerKeys = new Set<string>()
  for (const provider of providers) {
    const checked = validateProviderDefinition(provider)
    if (!checked.valid || !checked.manifest || !checked.providerHash) throw new TwinProviderRegistryError('PROVIDER_INVALID', checked.errors.join('; ') || 'Provider definition is invalid')
    const providerKey = key(checked.manifest.providerId, checked.manifest.version)
    const duplicate = stagedProviders.find(value => value.key === providerKey)
    if (duplicate && duplicate.providerHash !== checked.providerHash) throw new TwinProviderRegistryError('PROVIDER_CONFLICT', `Contribution contains conflicting providers for ${providerKey}`)
    if (!providerKeys.has(providerKey)) {
      providerKeys.add(providerKey)
      stagedProviders.push({ provider, manifest: checked.manifest, providerHash: checked.providerHash, key: providerKey })
    }
  }
  const scenePacks: StagedContribution['scenePacks'] = []; const sceneKeys = new Set<string>()
  for (const pack of contribution.scenePacks ?? []) {
    if (!isRecord(pack) || !text(pack.sceneKind) || !text(pack.sceneSchemaVersion)) throw new TwinProviderRegistryError('SCENE_PACK_INVALID', 'ScenePack requires sceneKind and sceneSchemaVersion')
    const packValue = pack as unknown as Record<string, unknown>
    for (const method of ['discover', 'compile'] as const) {
      if (packValue[method] != null && typeof packValue[method] !== 'function') throw new TwinProviderRegistryError('SCENE_PACK_INVALID', `ScenePack ${pack.sceneKind}.${method} must be a function when provided`)
    }
    for (const field of ['objectives', 'constraints', 'datasetSchema'] as const) {
      const value = packValue[field]
      if (value != null && typeof value !== 'function' && !Array.isArray(value) && !isRecord(value)) throw new TwinProviderRegistryError('SCENE_PACK_INVALID', `ScenePack ${pack.sceneKind}.${field} has an unsupported shape`)
    }
    const sceneKey = `${pack.sceneKind}@${pack.sceneSchemaVersion}`
    if (!sceneKeys.has(sceneKey)) { sceneKeys.add(sceneKey); scenePacks.push({ pack, key: sceneKey }) }
  }
  const solverAdapters: StagedContribution['solverAdapters'] = []; const solverKeys = new Set<string>()
  for (const adapter of contribution.solverAdapters ?? []) {
    const manifest = solverManifest(adapter); const solverKey = key(manifest.adapterId, manifest.version)
    if (!solverKeys.has(solverKey)) { solverKeys.add(solverKey); solverAdapters.push({ adapter, manifest, key: solverKey }) }
  }
  return { providers: stagedProviders, scenePacks, solverAdapters }
}

export class TwinProviderRegistry {
  private readonly generations = new Map<string, GenerationRecord>()
  private readonly nextGenerationByPlugin = new Map<string, number>()
  private leaseSequence = 0

  registerTwinPluginContribution(pluginName: string, contribution: TwinPluginContribution, generation?: number): TwinProviderRegistrationResult {
    const source = sourceOf(pluginName)
    if (!source.pluginName) throw new TwinProviderRegistryError('PLUGIN_NAME_MISSING', 'pluginName is required')
    if (!isRecord(contribution)) throw new TwinProviderRegistryError('CONTRIBUTION_INVALID', 'Twin plugin contribution must be an object')
    const active = this.currentGeneration(source.pluginName)
    const requested = generation == null ? active?.generation ?? this.allocateGeneration(source.pluginName) : this.assertGeneration(generation)
    this.nextGenerationByPlugin.set(source.pluginName, Math.max(this.nextGenerationByPlugin.get(source.pluginName) ?? 0, requested))
    const targetKey = generationKey(source.pluginName, requested)
    const existing = this.generations.get(targetKey)
    if (existing?.state === 'RETIRED') throw new TwinProviderRegistryError('GENERATION_RETIRED', `Plugin ${source.pluginName} generation ${requested} is retired`)
    if (existing?.state === 'DRAINING') throw new TwinProviderRegistryError('GENERATION_DRAINING', `Plugin ${source.pluginName} generation ${requested} is draining`)
    const staged = stageContribution(contribution)
    const target = existing ?? {
      pluginName: source.pluginName, pluginVersion: source.pluginVersion, generation: requested, state: 'VALIDATED' as ProviderLifecycleState,
      registeredAt: new Date().toISOString(), providers: new Map<string, ProviderRecord>(), scenePacks: new Map<string, ScenePack>(), solverAdapters: new Map<string, SolverAdapter>(),
    } satisfies GenerationRecord
    let added = 0
    for (const item of staged.providers) {
      const current = target.providers.get(item.key)
      if (current) {
        if (current.providerHash !== item.providerHash) throw new TwinProviderRegistryError('PROVIDER_CONFLICT', `Provider ${item.key} conflicts in plugin ${source.pluginName} generation ${requested}`)
        continue
      }
      this.assertProviderKeyAvailable(item.key, source.pluginName, requested)
      target.providers.set(item.key, {
        provider: item.provider, manifest: item.manifest, providerHash: item.providerHash, pluginName: source.pluginName, pluginVersion: source.pluginVersion,
        generation: requested, state: 'READY', health: normalizeProviderHealth(undefined), inFlight: 0, registeredAt: target.registeredAt,
      })
      added++
    }
    for (const item of staged.scenePacks) target.scenePacks.set(item.key, item.pack)
    for (const item of staged.solverAdapters) target.solverAdapters.set(item.key, item.adapter)
    target.pluginVersion = source.pluginVersion ?? target.pluginVersion
    target.state = target.providers.size || target.scenePacks.size || target.solverAdapters.size ? 'READY' : 'REGISTERED'
    this.generations.set(targetKey, target)
    for (const record of this.generations.values()) {
      if (record.pluginName === source.pluginName && record.generation !== requested && record.state !== 'RETIRED' && record.state !== 'FAILED') this.markGenerationDraining(record)
    }
    return { ok: true, pluginName: source.pluginName, generation: requested, providerIds: staged.providers.map(item => item.manifest.providerId), sceneKinds: staged.scenePacks.map(item => item.pack.sceneKind), solverAdapterIds: staged.solverAdapters.map(item => item.manifest.adapterId), state: target.state, idempotent: existing != null && added === 0 }
  }

  unregisterTwinPluginContribution(pluginName: string, generation?: number): TwinProviderUnregistrationResult {
    const plugin = text(pluginName); if (!plugin) throw new TwinProviderRegistryError('PLUGIN_NAME_MISSING', 'pluginName is required')
    const records = [...this.generations.values()].filter(record => record.pluginName === plugin && (generation == null || record.generation === generation)).sort((a, b) => a.generation - b.generation)
    const drainedGenerations: number[] = []; const retiredGenerations: number[] = []
    for (const record of records) {
      if (record.state !== 'RETIRED') { this.markGenerationDraining(record); drainedGenerations.push(record.generation) }
      if (record.state === 'RETIRED') retiredGenerations.push(record.generation)
    }
    return { ok: true, pluginName: plugin, generation, drainedGenerations, retiredGenerations }
  }

  registerPhysicsProvider(provider: TwinPhysicsProvider, source: TwinRegistrationSource = 'core', generation?: number): TwinProviderRegistrationResult {
    const sourceInfo = sourceOf(typeof source === 'string' ? source : source.pluginName, source)
    return this.registerTwinPluginContribution(sourceInfo.pluginName, { providers: [provider] }, generation)
  }

  registerScenePack(pack: ScenePack, source: TwinRegistrationSource = 'core', generation?: number): TwinProviderRegistrationResult {
    const sourceInfo = sourceOf(typeof source === 'string' ? source : source.pluginName, source)
    return this.registerTwinPluginContribution(sourceInfo.pluginName, { scenePacks: [pack] }, generation)
  }

  registerSolverAdapter(adapter: SolverAdapter, source: TwinRegistrationSource = 'core', generation?: number): TwinProviderRegistrationResult {
    const sourceInfo = sourceOf(typeof source === 'string' ? source : source.pluginName, source)
    return this.registerTwinPluginContribution(sourceInfo.pluginName, { solverAdapters: [adapter] }, generation)
  }

  reloadGeneration(pluginName: string, contribution: TwinPluginContribution, generation?: number): TwinProviderRegistrationResult
  reloadGeneration(pluginName: string, generation: number, contribution: TwinPluginContribution): TwinProviderRegistrationResult
  reloadGeneration(pluginName: string, contributionOrGeneration: TwinPluginContribution | number, maybeContribution?: TwinPluginContribution | number): TwinProviderRegistrationResult {
    const contribution = typeof contributionOrGeneration === 'number' ? maybeContribution as TwinPluginContribution : contributionOrGeneration
    const requested = typeof contributionOrGeneration === 'number' ? contributionOrGeneration : typeof maybeContribution === 'number' ? maybeContribution : this.allocateGeneration(pluginName)
    if (!contribution) throw new TwinProviderRegistryError('CONTRIBUTION_INVALID', 'reloadGeneration requires a contribution')
    return this.registerTwinPluginContribution(pluginName, contribution, requested)
  }

  reloadProvider(pluginName: string, contribution: TwinPluginContribution, generation?: number): TwinProviderRegistrationResult { return this.reloadGeneration(pluginName, contribution, generation) }

  resolveProvider(providerId: string, versionOrOptions?: string | ResolveProviderOptions, maybeOptions?: ResolveProviderOptions): TwinProviderLease | undefined {
    const version = typeof versionOrOptions === 'string' ? versionOrOptions : undefined
    const options = (typeof versionOrOptions === 'object' ? versionOrOptions : maybeOptions) ?? {}
    const record = this.findProviderRecords(providerId, version, options)[0]
    return record ? this.createLease(record) : undefined
  }

  resolve(providerId: string, versionOrOptions?: string | ResolveProviderOptions, maybeOptions?: ResolveProviderOptions): TwinProviderLease | undefined {
    return this.resolveProvider(providerId, versionOrOptions, maybeOptions)
  }

  acquireProvider(providerId: string, versionOrOptions?: string | ResolveProviderOptions, maybeOptions?: ResolveProviderOptions): TwinProviderLease | undefined {
    return this.resolveProvider(providerId, versionOrOptions, maybeOptions)
  }

  listProviders(filter: TwinProviderFilter = {}): TwinProviderSummary[] {
    const result: TwinProviderSummary[] = []
    for (const generation of this.generations.values()) {
      for (const record of generation.providers.values()) {
        if (filter.providerId && record.manifest.providerId !== filter.providerId) continue
        if (filter.version && record.manifest.version !== filter.version) continue
        if (filter.pluginName && record.pluginName !== filter.pluginName) continue
        if (filter.generation != null && record.generation !== filter.generation) continue
        if (filter.states?.length && !filter.states.includes(record.state)) continue
        if (record.state === 'DRAINING' && !filter.includeDraining) continue
        if (record.state === 'RETIRED' && !filter.includeRetired) continue
        if (record.state === 'FAILED' && !filter.includeFailed) continue
        result.push(this.toSummary(record))
      }
    }
    return result.sort((a, b) => b.generation - a.generation || a.providerId.localeCompare(b.providerId) || a.version.localeCompare(b.version))
  }

  listTwinProviders(filter: TwinProviderFilter = {}): TwinProviderSummary[] { return this.listProviders(filter) }

  listGenerations(pluginName?: string): TwinProviderGenerationSummary[] {
    return [...this.generations.values()]
      .filter(record => !pluginName || record.pluginName === pluginName)
      .map(record => ({
        pluginName: record.pluginName, pluginVersion: record.pluginVersion, generation: record.generation,
        state: this.generationState(record), providerIds: [...record.providers.values()].map(provider => provider.manifest.providerId),
        inFlight: [...record.providers.values()].reduce((total, provider) => total + provider.inFlight, 0), registeredAt: record.registeredAt,
        drainingAt: record.drainingAt, retiredAt: record.retiredAt,
      }))
      .sort((a, b) => b.generation - a.generation)
  }

  listScenePacks(pluginName?: string): ScenePack[] {
    return [...this.generations.values()].filter(record => (!pluginName || record.pluginName === pluginName) && record.state !== 'RETIRED').flatMap(record => [...record.scenePacks.values()])
  }

  listSolverAdapters(pluginName?: string): SolverAdapter[] {
    return [...this.generations.values()].filter(record => (!pluginName || record.pluginName === pluginName) && record.state !== 'RETIRED').flatMap(record => [...record.solverAdapters.values()])
  }

  getProviderHealth(providerId: string, version?: string, generation?: number): ProviderHealth | undefined {
    return this.findProviderRecords(providerId, version, { generation, allowDraining: true, includeFailed: true })[0]?.health
  }

  async checkProviderHealth(providerId: string, version?: string, generation?: number): Promise<ProviderHealth> {
    const record = this.findProviderRecords(providerId, version, { generation, allowDraining: true, includeFailed: true })[0]
    if (!record) throw new TwinProviderRegistryError('PROVIDER_NOT_FOUND', `Provider ${providerId}${version ? `@${version}` : ''} is not registered`)
    const health = await probeProviderHealth(record.provider)
    record.health = health
    if (health.status === 'unhealthy' && record.state !== 'RETIRED' && record.state !== 'DRAINING') record.state = 'FAILED'
    else if (health.status !== 'unhealthy' && record.state === 'FAILED') record.state = 'READY'
    this.updateGenerationState(this.generationOf(record))
    return health
  }

  validateProvider(providerId: string, version?: string, generation?: number): ProviderValidationResult {
    const record = this.findProviderRecords(providerId, version, { generation, allowDraining: true, includeFailed: true })[0]
    if (!record) return { valid: false, errors: [`Provider ${providerId}${version ? `@${version}` : ''} is not registered`], warnings: [] }
    const result = validateProviderDefinition(record.provider)
    if (record.state === 'FAILED' || !providerHealthAllowsUse(record.health)) result.valid = false
    return result
  }

  drainGeneration(pluginName: string, generation: number): TwinProviderDrainResult {
    const record = this.generations.get(generationKey(pluginName, generation))
    if (!record) throw new TwinProviderRegistryError('GENERATION_NOT_FOUND', `Plugin ${pluginName} generation ${generation} is not registered`)
    this.markGenerationDraining(record)
    const providers = [...record.providers.values()]
    const state = this.generationState(record)
    return { ok: true, pluginName, generation, state, inFlight: providers.reduce((total, provider) => total + provider.inFlight, 0), retired: state === 'RETIRED', providerIds: providers.map(provider => provider.manifest.providerId) }
  }

  drain(pluginName: string, generation: number): TwinProviderDrainResult { return this.drainGeneration(pluginName, generation) }

  drainProvider(providerId: string, version?: string, generation?: number): TwinProviderDrainResult {
    const record = this.findProviderRecords(providerId, version, { generation, allowDraining: true, includeFailed: true })[0]
    if (!record) throw new TwinProviderRegistryError('PROVIDER_NOT_FOUND', `Provider ${providerId}${version ? `@${version}` : ''} is not registered`)
    if (record.state !== 'RETIRED') {
      record.state = record.inFlight > 0 ? 'DRAINING' : 'RETIRED'; record.drainingAt ??= new Date().toISOString()
      if (record.state === 'RETIRED') record.retiredAt = new Date().toISOString()
      this.updateGenerationState(this.generationOf(record))
    }
    return { ok: true, pluginName: record.pluginName, generation: record.generation, state: record.state, inFlight: record.inFlight, retired: record.state === 'RETIRED', providerIds: [record.manifest.providerId] }
  }

  retireProvider(providerId: string, version: string, generation?: number): TwinProviderRetireResult {
    const record = this.findProviderRecords(providerId, version, { generation, allowDraining: true, includeFailed: true })[0]
    if (!record) throw new TwinProviderRegistryError('PROVIDER_NOT_FOUND', `Provider ${providerId}@${version} is not registered`)
    if (record.state !== 'RETIRED') {
      record.state = record.inFlight > 0 ? 'DRAINING' : 'RETIRED'; record.drainingAt ??= new Date().toISOString()
      if (record.state === 'RETIRED') record.retiredAt = new Date().toISOString()
      this.updateGenerationState(this.generationOf(record))
    }
    return { ok: true, providerId, version, generation: record.generation, state: record.state, inFlight: record.inFlight, retired: record.state === 'RETIRED' }
  }

  retire(providerId: string, version: string, generation?: number): TwinProviderRetireResult { return this.retireProvider(providerId, version, generation) }

  clear(): void { this.generations.clear(); this.nextGenerationByPlugin.clear(); this.leaseSequence = 0 }

  private assertProviderKeyAvailable(providerKey: string, pluginName: string, generation: number): void {
    for (const record of this.generations.values()) {
      if (record.pluginName === pluginName && record.generation === generation) continue
      const provider = record.providers.get(providerKey)
      if (provider && provider.state !== 'RETIRED') throw new TwinProviderRegistryError('PROVIDER_IDENTITY_CONFLICT', `Provider ${providerKey} is already registered by ${record.pluginName} generation ${record.generation}`)
    }
  }

  private createLease(record: ProviderRecord): TwinProviderLease {
    if (record.state === 'RETIRED' || record.state === 'FAILED') return undefined as never
    record.inFlight++
    const refId = `twin-provider-ref-${++this.leaseSequence}`
    let released = false
    return {
      refId, provider: record.provider, manifest: record.manifest,
      lineage: { providerId: record.manifest.providerId, providerVersion: record.manifest.version, providerHash: record.providerHash, pluginName: record.pluginName, generation: record.generation },
      generation: record.generation,
      get released() { return released },
      release: () => {
        if (released) return
        released = true; record.inFlight = Math.max(0, record.inFlight - 1)
        if (record.state === 'DRAINING' && record.inFlight === 0) { record.state = 'RETIRED'; record.retiredAt = new Date().toISOString() }
        this.updateGenerationState(this.generationOf(record))
      },
    }
  }

  private findProviderRecords(providerId: string, version?: string, options: ResolveProviderOptions = {}): ProviderRecord[] {
    const records: ProviderRecord[] = []
    for (const generation of this.generations.values()) {
      for (const record of generation.providers.values()) {
        if (record.manifest.providerId !== providerId || (version && record.manifest.version !== version)) continue
        if (options.generation != null && record.generation !== options.generation) continue
        if (record.state === 'RETIRED' || (record.state === 'FAILED' && !options.includeFailed) || (record.state === 'DRAINING' && !options.allowDraining)) continue
        records.push(record)
      }
    }
    return records.sort((a, b) => b.generation - a.generation || b.registeredAt.localeCompare(a.registeredAt))
  }

  private toSummary(record: ProviderRecord): TwinProviderSummary {
    return { providerId: record.manifest.providerId, version: record.manifest.version, providerHash: record.providerHash, pluginName: record.pluginName, pluginVersion: record.pluginVersion, generation: record.generation, state: record.state, health: record.health, inFlight: record.inFlight, registeredAt: record.registeredAt, drainingAt: record.drainingAt, retiredAt: record.retiredAt, manifest: record.manifest }
  }

  private currentGeneration(pluginName: string): GenerationRecord | undefined {
    return [...this.generations.values()].filter(record => record.pluginName === pluginName && !['RETIRED', 'FAILED', 'DRAINING'].includes(record.state)).sort((a, b) => b.generation - a.generation)[0]
  }

  private allocateGeneration(pluginName: string): number {
    const next = (this.nextGenerationByPlugin.get(pluginName) ?? 0) + 1
    this.nextGenerationByPlugin.set(pluginName, next)
    return next
  }

  private assertGeneration(value: number): number {
    if (!Number.isInteger(value) || value <= 0) throw new TwinProviderRegistryError('GENERATION_INVALID', `generation must be a positive integer: ${value}`)
    return value
  }

  private generationOf(provider: ProviderRecord): GenerationRecord {
    const generation = this.generations.get(generationKey(provider.pluginName, provider.generation))
    if (!generation) throw new TwinProviderRegistryError('GENERATION_NOT_FOUND', `Generation ${provider.pluginName}@${provider.generation} no longer exists`)
    return generation
  }

  private markGenerationDraining(record: GenerationRecord): void {
    if (record.state === 'RETIRED') return
    record.drainingAt ??= new Date().toISOString()
    for (const provider of record.providers.values()) {
      if (provider.state === 'READY' || provider.state === 'REGISTERED' || provider.state === 'VALIDATED') {
        provider.state = provider.inFlight > 0 ? 'DRAINING' : 'RETIRED'; provider.drainingAt ??= record.drainingAt
        if (provider.state === 'RETIRED') provider.retiredAt = new Date().toISOString()
      }
    }
    this.updateGenerationState(record)
  }

  private updateGenerationState(record: GenerationRecord): void {
    const providers = [...record.providers.values()]
    if (providers.length) {
      if (providers.every(provider => provider.state === 'RETIRED')) { record.state = 'RETIRED'; record.retiredAt ??= new Date().toISOString(); return }
      if (providers.some(provider => provider.state === 'DRAINING')) { record.state = 'DRAINING'; return }
      if (providers.every(provider => provider.state === 'FAILED')) { record.state = 'FAILED'; return }
      record.state = 'READY'; return
    }
    if (record.state === 'DRAINING') { record.state = 'RETIRED'; record.retiredAt ??= new Date().toISOString() }
  }

  private generationState(record: GenerationRecord): ProviderLifecycleState { this.updateGenerationState(record); return record.state }
}

const twinProviderRegistry = new TwinProviderRegistry()

export function getTwinProviderRegistry(): TwinProviderRegistry { return twinProviderRegistry }
export function registerTwinPluginContribution(pluginName: string, contribution: TwinPluginContribution, generation?: number): TwinProviderRegistrationResult { return twinProviderRegistry.registerTwinPluginContribution(pluginName, contribution, generation) }
export function unregisterTwinPluginContribution(pluginName: string, generation?: number): TwinProviderUnregistrationResult { return twinProviderRegistry.unregisterTwinPluginContribution(pluginName, generation) }
export function listTwinProviders(filter: TwinProviderFilter = {}): TwinProviderSummary[] { return twinProviderRegistry.listProviders(filter) }
export function resolveTwinProvider(providerId: string, versionOrOptions?: string | ResolveProviderOptions, maybeOptions?: ResolveProviderOptions): TwinProviderLease | undefined { return twinProviderRegistry.resolveProvider(providerId, versionOrOptions, maybeOptions) }
export function acquireTwinProvider(providerId: string, versionOrOptions?: string | ResolveProviderOptions, maybeOptions?: ResolveProviderOptions): TwinProviderLease | undefined { return twinProviderRegistry.acquireProvider(providerId, versionOrOptions, maybeOptions) }
export function reloadTwinProviderGeneration(pluginName: string, contribution: TwinPluginContribution, generation?: number): TwinProviderRegistrationResult { return twinProviderRegistry.reloadGeneration(pluginName, contribution, generation) }
export function drainTwinProviderGeneration(pluginName: string, generation: number): TwinProviderDrainResult { return twinProviderRegistry.drainGeneration(pluginName, generation) }
export function retireTwinProvider(providerId: string, version: string, generation?: number): TwinProviderRetireResult { return twinProviderRegistry.retireProvider(providerId, version, generation) }
export function registerTwinPhysicsProvider(provider: TwinPhysicsProvider, source: TwinRegistrationSource = 'core', generation?: number): TwinProviderRegistrationResult { return twinProviderRegistry.registerPhysicsProvider(provider, source, generation) }
export function registerTwinScenePack(pack: ScenePack, source: TwinRegistrationSource = 'core', generation?: number): TwinProviderRegistrationResult { return twinProviderRegistry.registerScenePack(pack, source, generation) }
export function registerTwinSolverAdapter(adapter: SolverAdapter, source: TwinRegistrationSource = 'core', generation?: number): TwinProviderRegistrationResult { return twinProviderRegistry.registerSolverAdapter(adapter, source, generation) }

export type { LegacyPhysicsProvider, UniversalPhysicsProvider }


