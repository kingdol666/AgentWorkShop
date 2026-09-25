import type { PhysicsModelProvider, PhysicsState, PhysicsStepResult, PhysicsInput, PhysicsTrajectory } from './physics-runtime'
import type { PhysicsModelManifest, SceneContract, TwinSnapshot, ObjectiveProfile } from './contracts'

export const TWIN_PROVIDER_API_VERSION = 'twin-provider.v1' as const
export type ProviderLifecycleState = 'DISCOVERED'|'VALIDATED'|'REGISTERED'|'READY'|'DRAINING'|'RETIRED'|'FAILED'
export type TwinProviderLifecycle = ProviderLifecycleState
export type TwinProviderBackend = 'typescript'|'pytorch'|'python'|'onnx'|'rom'|'external-solver'
export type ProviderManifestAccessor = PhysicsProviderManifest | (() => PhysicsProviderManifest)
export type LegacyPhysicsProvider = PhysicsModelProvider

export interface VariableSpec { id: string, unit?: string, role?: string, physicalMeaning?: string, min?: number, max?: number, maxStep?: number, samplingPeriodMs?: number, metadata?: Record<string, unknown> }
export type ParameterPriorMap = Record<string, { min: number, max: number, unit?: string, distribution?: string, metadata?: Record<string, unknown> }>
export interface ArtifactContract { schemaVersion?: string|number, requiredArtifacts?: string[], optionalArtifacts?: string[], formats?: Record<string,string>, metadata?: Record<string,unknown> }
export interface PhysicsProviderManifest {
  providerId: string
  version: string
  apiVersion: typeof TWIN_PROVIDER_API_VERSION
  sceneKinds: string[]
  backend: TwinProviderBackend
  stateVariables: VariableSpec[]
  controlVariables: VariableSpec[]
  disturbanceVariables: VariableSpec[]
  observationVariables?: VariableSpec[]
  parameterPriors: ParameterPriorMap
  capabilities?: { onlineStep?: boolean, rollout?: boolean, calibration?: boolean, uncertainty?: boolean, externalSolver?: boolean, mpc?: boolean }
  artifactContract?: ArtifactContract
  displayName?: string
  description?: string
  createdBy?: string
  sourceHash?: string
  artifactHash?: string
  metadata?: Record<string,unknown>
}
export type ProviderHealthStatus = 'healthy'|'unhealthy'|'degraded'|'unknown'
export interface ProviderHealth { status: ProviderHealthStatus, checkedAt?: string, detail?: string, message?: string, latencyMs?: number, errors?: string[], checks?: Array<{ id:string, status:ProviderHealthStatus, message?:string, latencyMs?:number, details?:Record<string,unknown> }>, [key:string]: unknown }
export interface ProviderValidationResult { valid: boolean, errors: string[], warnings: string[], manifest?: PhysicsProviderManifest, providerHash?: string }
export interface UniversalPhysicsProvider extends PhysicsModelProvider { readonly manifest: any, validateScene?(scene: SceneContract): { ok?: boolean, valid?: boolean, errors?: string[], warnings?: string[] }, calibrate?(input: unknown): Promise<unknown>|unknown, designSafeExperiment?(input: unknown): unknown, estimateUncertainty?(input: unknown): Promise<unknown>|unknown, exportArtifacts?(): Promise<unknown>|unknown, health?(): Promise<ProviderHealth>|ProviderHealth }
export type TwinPhysicsProvider = UniversalPhysicsProvider
export type TwinProviderManifest = PhysicsProviderManifest

export interface ScenePack { sceneKind: string, sceneSchemaVersion: string, discover?(input: { lineId: string, boundDaqNodes: unknown[], boundDcwNodes: unknown[] }): Promise<unknown>|unknown, compile?(input: { userPrompt?: string, nodeCatalog: unknown[], lineContext?: unknown }): Promise<SceneContract>|SceneContract, objectives?: ObjectiveProfile[], constraints?: unknown[], datasetSchema?: Record<string,unknown>, metadata?: Record<string,unknown> }
export interface TwinScenePack extends ScenePack { scenePackId?: string, version?: string, sceneKinds?: string[] }
export interface SolverAdapterManifest { adapterId: string, version: string, backend?: string, capabilities?: Record<string,unknown>, inputSchema?: Record<string,unknown>, outputSchema?: Record<string,unknown>, metadata?: Record<string,unknown> }
export interface SolverAdapter { manifest: SolverAdapterManifest, solve(input: unknown, limits?: Record<string,unknown>): Promise<unknown>|unknown, cancel?(runId:string): Promise<void>, health?(): Promise<ProviderHealth>|ProviderHealth }
export interface TwinSolverAdapter extends SolverAdapter { solverId?: string }
export interface TwinPluginContribution { providers?: TwinPhysicsProvider[], scenePacks?: ScenePack[], objectiveProfiles?: ObjectiveProfile[], solverAdapters?: SolverAdapter[] }
export type TwinRegistrationSource = string | { pluginName: string, pluginVersion?: string, source?: string, scope?: string, version?: string, plugin?: string, name?: string, [key:string]: unknown }
export interface TwinProviderFilter { providerId?: string, version?: string, pluginName?: string, generation?: number, states?: ProviderLifecycleState[], includeDraining?: boolean, includeRetired?: boolean, includeFailed?: boolean, sceneKind?: string, [key:string]: unknown }
export interface TwinProviderSummary { providerId: string, version: string, providerHash: string, pluginName: string, pluginVersion?: string, generation: number, state: ProviderLifecycleState, health: ProviderHealth, inFlight: number, registeredAt: string, drainingAt?: string, retiredAt?: string, manifest: PhysicsProviderManifest }
export interface TwinProviderLease { refId: string, provider: TwinPhysicsProvider, manifest: PhysicsProviderManifest, lineage: { providerId:string, providerVersion:string, providerHash:string, pluginName:string, generation:number }, generation:number, released?: boolean, release(): void }
export interface TwinProviderRegistrationResult { ok: boolean, pluginName: string, generation: number, providerIds: string[], sceneKinds: string[], solverAdapterIds: string[], state: ProviderLifecycleState, idempotent?: boolean }
export interface TwinProviderUnregistrationResult { ok: boolean, pluginName: string, generation?: number, drainedGenerations: number[], retiredGenerations: number[] }
export interface TwinProviderDrainResult { ok:boolean, pluginName:string, generation:number, state:ProviderLifecycleState, inFlight:number, retired:boolean, providerIds:string[] }
export interface TwinProviderRetireResult { ok:boolean, providerId:string, version:string, generation:number, state:ProviderLifecycleState, inFlight:number, retired:boolean }
export type TwinProviderRef = { providerId:string, providerVersion?:string, providerHash?:string, generation?:number }

export type TwinRegistrationKind = 'registerPhysicsProvider'|'registerScenePack'|'registerObjectiveProfile'|'registerTrainingAdapter'|'registerSolverAdapter'
export type TwinPluginBridgeOperation = { op:'register', pluginName:string, contribution:TwinPluginContribution, generation?:number } | { op:'unregister', pluginName:string, generation?:number }
export interface TwinPluginExtBridge {
  pending: TwinPluginBridgeOperation[]
  _drain?: (()=>void)
  registerTwinPluginContribution(pluginName:string, contribution:TwinPluginContribution, generation?:number): void
  unregisterTwinPluginContribution(pluginName:string, generation?:number): void
  drain(onRegister:(pluginName:string, contribution:TwinPluginContribution, generation?:number)=>unknown, onUnregister?:(pluginName:string,generation?:number)=>unknown): void
  listTwinProviders?: (filter?:TwinProviderFilter)=>TwinProviderSummary[]
  [key:string]: unknown
}

// Compatibility aliases used by early Core AML code.
export type TwinProviderBackendLegacy = PhysicsModelManifest['backend']
export type TwinProviderCapabilities = PhysicsProviderManifest['capabilities']
export interface TwinVariableSpec extends VariableSpec {}
export interface TwinArtifactContract extends ArtifactContract {}
export interface TwinValidationResult { ok:boolean, errors?:string[], warnings?:string[] }
export interface TwinCalibrationInput { datasetId?:string, rows?:number, snapshot?:TwinSnapshot, priors?:Record<string,unknown>, options?:Record<string,unknown> }
export interface TwinCalibrationResult { ok:boolean, parameters?:Record<string,number>, metrics?:Record<string,number|string|boolean>, artifact?:Record<string,unknown>, errors?:string[] }
export interface TwinExperimentDesignInput { scene:SceneContract, baselineControls:Record<string,number>, objective?:ObjectiveProfile, modelReady?:boolean, limits?:Record<string,unknown> }
export interface TwinExperimentPlan { mode:'safe_small_step'|'precise_search', candidates:Array<Record<string,number>>, rationale?:string }
export interface TwinUncertaintyInput { snapshot?:TwinSnapshot, trajectory?:PhysicsTrajectory, input?:Record<string,number> }
export interface TwinUncertaintyResult { coverage:number, accepted:boolean, maxStd?:number, distance?:number, disagreement?:number, rejectCode?:string }
export interface TwinArtifactManifest { providerId:string, providerVersion:string, providerHash?:string, files:string[], root?:string, metadata?:Record<string,unknown> }
export interface TwinProviderHealth { providerId?:string, providerVersion?:string, status:string, checkedAt:string, detail?:string, errors?:string[], [key:string]:unknown }


/** Optional explicit alias accepted by the global plugin bridge. */
export interface TwinPluginContribution { physicsProviders?: TwinPhysicsProvider[] }
