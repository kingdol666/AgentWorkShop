import { getTwinProviderRegistry, type TwinProviderRegistry } from './provider-registry'
import type { TwinPluginContribution, TwinPluginExtBridge, TwinPluginBridgeOperation, TwinProviderFilter, TwinProviderSummary, TwinRegistrationSource, TwinPhysicsProvider, ScenePack, SolverAdapter } from './provider-contracts'
export interface TwinPluginBridgeGlobal { __twinPluginExt?: any }
function sourceName(source: TwinRegistrationSource|string|undefined): { pluginName:string, pluginVersion?:string, source?:string } { if(typeof source==='string') return {pluginName:source}; return {pluginName:String(source?.pluginName??source?.plugin??source?.name??'external-twin-plugin'),pluginVersion:source?.pluginVersion??source?.version,source:source?.source??source?.scope} }
function normalizePack(payload:any): ScenePack { return { ...payload, sceneKind: payload.sceneKind ?? payload.scenePackId ?? 'unknown-scene', sceneSchemaVersion: payload.sceneSchemaVersion ?? payload.version ?? '1.0.0' } }
function registryApi(registry: TwinProviderRegistry) {
  return {
    register(kind:string, payload:unknown, source?:TwinRegistrationSource) {
      const s=sourceName(source)
      if(kind==='registerPhysicsProvider') return registry.registerPhysicsProvider(payload as TwinPhysicsProvider, s)
      if(kind==='registerScenePack') return registry.registerScenePack(normalizePack(payload as Record<string, unknown>), s)
      if(kind==='registerSolverAdapter') return registry.registerSolverAdapter(payload as SolverAdapter, s)
      if(kind==='registerObjectiveProfile' || kind==='registerTrainingAdapter') return { ok:true, accepted:true, capability:kind }
      throw new Error(`Unknown Twin registration kind: ${kind}`)
    },
    registerEntry(entry:{ kind:string, payload:unknown, source?:TwinRegistrationSource }) { return this.register(entry.kind, entry.payload, entry.source) },
    registerTwinPluginContribution(pluginName:string, contribution:TwinPluginContribution, generation?:number) { return registry.registerTwinPluginContribution(pluginName, contribution, generation) },
    unregisterTwinPluginContribution(pluginName:string, generation?:number) { return registry.unregisterTwinPluginContribution(pluginName, generation) },
    registerPhysicsProvider(payload: TwinPhysicsProvider, source?: TwinRegistrationSource) { const s=sourceName(source); return registry.registerTwinPluginContribution(s.pluginName,{providers:[payload]},undefined) },
    registerScenePack(payload: any, source?: TwinRegistrationSource) { const s=sourceName(source); return registry.registerTwinPluginContribution(s.pluginName,{scenePacks:[normalizePack(payload)]},undefined) },
    registerObjectiveProfile(_payload: unknown, _source?: TwinRegistrationSource) { return { ok:true, accepted:true, capability:'objective-profile' } },
    registerTrainingAdapter(_payload: unknown, _source?: TwinRegistrationSource) { return { ok:true, accepted:true, capability:'training-adapter' } },
    registerSolverAdapter(payload: SolverAdapter, source?: TwinRegistrationSource) { const s=sourceName(source); return registry.registerTwinPluginContribution(s.pluginName,{solverAdapters:[payload]},undefined) },
    listProviders(filter?: TwinProviderFilter): TwinProviderSummary[] { return registry.listProviders(filter) },
    listTwinProviders(filter?: TwinProviderFilter): TwinProviderSummary[] { return registry.listProviders(filter) },
    getProviderHealth(providerId:string, version?:string) { return registry.getProviderHealth(providerId,version) },
    resolveProvider(providerId:string, version?:string) { return registry.resolveProvider(providerId,version) },
    validateProvider(providerId:string, version?:string) { return registry.validateProvider(providerId,version) },
    retireProvider(providerId:string, version?:string) { return registry.retireProvider(providerId,version??'',undefined) },
    unregisterPlugin(source?: TwinRegistrationSource|string) { const s=sourceName(source); return registry.unregisterTwinPluginContribution(s.pluginName) },
    removePlugin(source?: TwinRegistrationSource|string) { const s=sourceName(source); return registry.unregisterTwinPluginContribution(s.pluginName) },
  }
}
function isNativeBridge(value: unknown): value is TwinPluginExtBridge { return Boolean(value && typeof value==='object' && Array.isArray((value as any).pending) && typeof (value as any).registerTwinPluginContribution==='function' && typeof (value as any).drain==='function') }
export function createTwinPluginBridge(): TwinPluginExtBridge { const pending:TwinPluginBridgeOperation[]=[]; let drainPending:(()=>void)|undefined; const bridge:TwinPluginExtBridge={pending,get _drain(){return drainPending},set _drain(v){drainPending=v},registerTwinPluginContribution(pluginName,contribution,generation){pending.push({op:'register',pluginName,contribution,generation});drainPending?.()},unregisterTwinPluginContribution(pluginName,generation){pending.push({op:'unregister',pluginName,generation});drainPending?.()},drain(onRegister,onUnregister=()=>{}){drainPending=()=>{for(const op of pending.splice(0))op.op==='register'?onRegister(op.pluginName,op.contribution,op.generation):onUnregister(op.pluginName,op.generation)};drainPending()}};return bridge }
export function loadTwinPluginContribution(pluginName:string, contribution:TwinPluginContribution,generation?:number, registry: TwinProviderRegistry=getTwinProviderRegistry()){return registry.registerTwinPluginContribution(pluginName,contribution,generation)}
export function unloadTwinPluginContribution(pluginName:string,generation?:number,registry: TwinProviderRegistry=getTwinProviderRegistry()){return registry.unregisterTwinPluginContribution(pluginName,generation)}
export function attachTwinPluginBridge(registry: TwinProviderRegistry=getTwinProviderRegistry()): any {
  const global=globalThis as unknown as TwinPluginBridgeGlobal; const existing=global.__twinPluginExt; const api=registryApi(registry)
  // SDK-created bridge exposes attach(registry): preserve its pending queue and let
  // it dispatch future kind/payload registrations into the typed Registry API.
  if(existing && typeof existing.attach==='function') { existing.attach(api); return existing }
  const bridge=isNativeBridge(existing)?existing:createTwinPluginBridge(); global.__twinPluginExt=bridge
  const registerApi = registryApi(registry) as any
  // Make the native bridge compatible with SDK's kind/payload/source dispatch.
  ;(bridge as any).register = (kind: string, payload: unknown, source?: TwinRegistrationSource) => {
    const fn = registerApi[kind]
    if (typeof fn !== 'function') throw new Error(`未知 Twin 注册类别:${kind}`)
    return fn(payload, source)
  }
  ;(bridge as any).registerEntry = (entry: any) => (bridge as any).register(entry?.kind, entry?.payload, entry?.source)
  ;(bridge as any).unregisterPlugin = (source?: TwinRegistrationSource|string) => registerApi.unregisterPlugin(source)
  ;(bridge as any).removePlugin = (source?: TwinRegistrationSource|string) => registerApi.unregisterPlugin(source)
  ;(bridge as any).listProviders = (filter?:TwinProviderFilter)=>registry.listProviders(filter)
  ;(bridge as any).listTwinProviders = (filter?:TwinProviderFilter)=>registry.listProviders(filter)
  ;(bridge as any).getProviderHealth = (providerId:string, version?:string)=>registry.getProviderHealth(providerId,version)
  ;(bridge as any).resolveProvider = (providerId:string, version?:string)=>registry.resolveProvider(providerId,version)
  ;(bridge as any).validateProvider = (providerId:string, version?:string)=>registry.validateProvider(providerId,version)
  ;(bridge as any).retireProvider = (providerId:string, version?:string)=>registry.retireProvider(providerId,version??'',undefined)
  bridge.drain((pluginName,contribution,generation)=>registry.registerTwinPluginContribution(pluginName,contribution,generation),(pluginName,generation)=>registry.unregisterTwinPluginContribution(pluginName,generation))
  return bridge
}
export const attachTwinProviderRegistry=attachTwinPluginBridge
export const createTwinPluginExt=createTwinPluginBridge



