/**
 * Hybrid Twin AML 工具：只做场景读取、快照、VirtualTrial、MPC recommendation-only。
 * 该工具族不拥有任何 DCW 写入能力；模型门禁未通过时仅返回 safe_small_step 试探。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentBadgeLabel } from '../agent-badge'
import { getAmlRuntime } from '../../aml/runtime'
import { defaultInjectionScene, InjectionGreyboxProvider, smallStepCandidates, type PhysicsModelProvider } from '../../aml/twin/physics-runtime'
import { assertTwinSnapshot, createTwinSnapshot } from '../../aml/twin/snapshot-service'
import { createNodeBindingSnapshot } from '../../aml/twin/binding-snapshot'
import { evaluateHybridGates, resolveAcceptanceProfile } from '../../aml/twin/acceptance'
import { parseSceneContract, sha256, type ObjectiveProfile, type SceneContract, type TwinSnapshot } from '../../aml/twin/contracts'
import { sceneContractHash, type SceneWithDraftMetadata } from '../../aml/twin/scene-lifecycle'
import { getDaqController } from '../../daq/daq-controller'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import type { HostToolResult } from '../host-tool-bridge/types'
import { recordOps } from '../../ops/ops'
import { createTwinRepo } from '../../aml/twin/repo'
import { requestCalibration, DEFAULT_TWIN_CALIBRATION_POLICY } from '../../aml/twin/calibration-scheduler'
import { getTwinProviderRegistry } from '../../aml/twin/provider-registry'
import { compileSceneDraft, discoverSceneNodes, type NodeSemanticInput } from '../../aml/twin/scene-builder'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { compileDeclarativeProvider } from '../../aml/twin/declarative-provider'
import { validatePhysicsSpec } from '../../aml/twin/physics-spec'
import { draftPhysicsSpecFromScene } from '../../aml/twin/physics-spec-draft'
import { ModelBackedHybridProvider, assertModelSceneLineage } from '../../aml/twin/model-backed-provider'
import { syncRolloutProvider, runVirtualTrial, issueRecommendationCertificate, type RolloutProvider } from '../../aml/twin/trial-service'
import { assertFrozenScene } from '../../aml/twin/scene-lifecycle'
import { getChannelTwinProfile } from '../../aml/twin/channel-profile'
import { channelIdForAgent } from '../../aml/twin/write-guard'
import { amlTwinFeatureFlags } from '../../aml/twin/feature-flags'

function ok(text: string): HostToolResult {
  return { text }
}
function fail(text: string): HostToolResult {
  return { text, isError: true }
}
function jsonArg<T>(args: Record<string, unknown>, key: string, fallback?: T): T | undefined {
  const value = args[key]
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    }
    catch {
      return fallback
    }
  }
  return value as T
}

async function persistTwinArtifact(kind: string, id: string, payload: unknown): Promise<string> {
  const rt = getAmlRuntime()
  const dir = join(rt.root, 'twins', kind, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${kind}.json`)
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
  return path
}

function providerForScene(scene: SceneContract, channelId?: string): { provider: PhysicsModelProvider, release: () => void, providerId: string, providerVersion: string, providerHash: string, providerGeneration: number } {
  const registry = getTwinProviderRegistry()
  const profile = channelId ? getChannelTwinProfile(channelId) : null
  const lineageKind = profile?.profile === 'hybrid_twin' || profile?.profile === 'aml_optimization'
  if (lineageKind && profile?.sceneId && profile.sceneId !== scene.sceneId) throw new Error('TWIN_SCENE_CHANNEL_MISMATCH')
  const requested = String(profile?.providerId || scene.physicsProfileId || 'injection-greybox-v1')
  const lease = profile?.providerVersion
    ? registry.resolveProvider(requested, profile.providerVersion, { generation: profile.providerGeneration, allowDraining: true })
    : registry.resolveProvider(requested, { generation: profile?.providerGeneration, allowDraining: true })
  if (lease) {
    if (profile?.providerHash && profile.providerHash !== lease.lineage.providerHash) {
      lease.release()
      throw new Error('TWIN_PROVIDER_HASH_MISMATCH')
    }
    return { provider: lease.provider, release: lease.release, providerId: lease.lineage.providerId, providerVersion: lease.lineage.providerVersion, providerHash: lease.lineage.providerHash, providerGeneration: lease.lineage.generation }
  }
  // 场景谱系通道(hybrid_twin / aml_optimization)与非注入 provider 缺注册一律 fail-closed;
  // aml_optimization 不允许静默回落注入物理模型 —— 优化通道的孪生评估必须有真模型或真 provider。
  if (lineageKind || requested !== 'injection-greybox-v1') throw new Error(`TWIN_PROVIDER_UNAVAILABLE:${requested}`)
  // Transitional compatibility is limited to an explicitly named injection scene/provider.
  const fallback = new InjectionGreyboxProvider()
  return { provider: fallback, release: () => {}, providerId: fallback.manifest.physicsModelId, providerVersion: fallback.manifest.version, providerHash: sha256({ ...fallback.manifest, createdAt: undefined }), providerGeneration: 0 }
}

export interface RolloutProviderRef {
  rollout: RolloutProvider
  modelId: string
  modelHash: string
  modelBacked: boolean
  release: () => void
  /** 模型驱动时的平台侧集成 UQ(rollout 后读取;coverage 来自训练工件) */
  uncertainty?: () => { predictions: Array<Record<string, number>>, coverage: number, calibrationFresh: boolean, inputDistance: number }
}

/**
 * 解析 VirtualTrial/MPC 的 rollout 模型面:
 *  - 给了 model_id → 必须是注册表中 stage ∈ candidate/shadow/production 的 hybrid 模型,
 *    且其数据集 line/product/recipe 与场景一致(配方隔离);真实工件(校准后 PhysicsSpec
 *    + 残差集成 ONNX)驱动每次 rollout,并提供平台侧集成 UQ;
 *  - 未给 → 物理_only provider(旧行为),model_id 仅作记录标签。
 */
export async function rolloutProviderFor(agentId: string, scene: SceneContract, snapshot: TwinSnapshot, modelId: string | undefined): Promise<RolloutProviderRef> {
  let requested = String(modelId ?? '').trim()
  if (!requested) {
    // 投用语义:未显式指定模型时,自动生效同场景谱系(产线/产品/配方一致)的 production 模型;
    // 无生产模型才回退物理_only —— 与 aml_model_promote「生产生效」承诺闭环。
    try {
      const rt = getAmlRuntime()
      const prod = rt.repo.model.list({ stage: 'production', purpose: 'mpc_surrogate', limit: 50 })
        .find((m) => {
          const ds = rt.repo.dataset.get(m.datasetId)
          if (!ds) return false
          if (scene.lineId && ds.lineId !== scene.lineId) return false
          if (scene.productId && ds.productId !== scene.productId) return false
          if (scene.recipeId && ds.recipeId !== scene.recipeId) return false
          return true
        })
      if (prod) requested = prod.id
    }
    catch { /* 注册表不可用时按无模型处理 */ }
  }
  if (!requested) {
    const physicsRef = providerForScene(scene, channelIdForAgent(agentId))
    return { rollout: syncRolloutProvider(physicsRef.provider), modelId: physicsRef.providerId, modelHash: physicsRef.providerHash, modelBacked: false, release: physicsRef.release }
  }
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(requested)
  if (!row) throw new Error(`TWIN_MODEL_MISSING:${requested}`)
  if (row.stage === 'retired') throw new Error(`TWIN_MODEL_RETIRED:${requested}`)
  const dataset = rt.repo.dataset.get(row.datasetId)
  if (!dataset) throw new Error(`TWIN_MODEL_DATASET_MISSING:${requested}`)
  assertModelSceneLineage(dataset, scene)
  const backed = await ModelBackedHybridProvider.create(row, {
    stateEstimate: snapshot.stateEstimate ?? {},
    controlValues: snapshot.controlValues ?? {},
    disturbances: snapshot.disturbances ?? {},
  })
  let modelHash = `model:${row.id}`
  try {
    modelHash = sha256(readFileSync(join(row.path, 'hybrid_manifest.json'), 'utf8'))
  }
  catch { /* manifest 读取失败时退化为 id 哈希锚 */ }
  return {
    rollout: backed,
    modelId: row.id,
    modelHash,
    modelBacked: true,
    release: () => {},
    uncertainty: () => {
      const u = backed.takeUncertainty()
      return { predictions: u.memberPredictions, coverage: u.calibrationCoverage ?? 0, calibrationFresh: u.calibrationCoverage != null, inputDistance: 0 }
    },
  }
}

/** 工具:twin_physics_spec_draft —— 从冻结场景生成骨架 PhysicsSpec(可校准/可训练的起步物理模型) */
export async function toolTwinPhysicsSpecDraft(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const supplied = jsonArg<Record<string, unknown>>(args, 'scene_json')
    let scene: SceneContract
    if (supplied) {
      scene = parseSceneContract(supplied)
    }
    else {
      const auth = authoritativeSceneForAgent(agentId, {}, defaultInjectionScene('twin-physics-draft'))
      scene = auth.scene
    }
    const dtSec = Number(args.dt_sec)
    const spec = draftPhysicsSpecFromScene({ scene, createdBy: agentId, ...(Number.isFinite(dtSec) && dtSec > 0 ? { dtSec } : {}) })
    const artifact = await persistTwinArtifact('physics-spec-draft', `${spec.modelId}-${Date.now().toString(36)}`, spec)
    const calibratable = spec.parameters.filter(p => p.min != null && p.max != null).length
    return ok([
      `PhysicsSpec 骨架已生成(场景 ${scene.sceneId}@${scene.sceneVersion}):`,
      `  model_id: ${spec.modelId} | 状态变量 ${spec.states.length} | 观测方程 ${spec.observations.length} | 参数 ${spec.parameters.length}(可校准 ${calibratable})`,
      `  结构: 每个 state = 一阶惯性弛豫(τ/增益为先验盒内可校准参数);观测 = persistence 恒等基线`,
      `  artifact: ${artifact}`,
      `下一步: 按真实工况润色方程 → twin_physics_spec_validate 校验 → twin_physics_spec_compile 编译候选(须已冻结场景)→ aml_job_submit(job_kind=hybrid_residual)训练校准;骨架的 τ/增益在训练 stage A 自动按数据拟合。`,
      `注意: dt_sec 需与训练数据集 beat 一致(缺省 1s);变量 id 已按标识符规则净化,nodeId 保留真实节点映射。`,
    ].join('\n'))
  }
  catch (err) {
    return fail(`PhysicsSpec 骨架生成失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

function authoritativeSceneForAgent(agentId: string, args: Record<string, unknown>, fallback: SceneContract): { scene: SceneWithDraftMetadata, channelId?: string, hybrid: boolean } {
  const channelId = channelIdForAgent(agentId)
  if (!channelId) return { scene: fallback, hybrid: false }
  const profile = getChannelTwinProfile(channelId)
  // 场景谱系通道:hybrid_twin 恒可;aml_optimization 仅 aml 模式(已绑模型)可 ——
  // 与 dispatch 层 modelBackedToolPolicyFor 同判,未绑模型时回落 fallback(探索模式
  // 的孪生工具在 dispatch 已被拒,这里只兜底)。优化通道实例化时存有
  // sceneId/sceneVersion,冻结契约按 sceneId 全局解析(训练通道冻结、优化通道复用)。
  const lineageKind = profile.profile === 'hybrid_twin'
    || (profile.profile === 'aml_optimization' && profile.optimizationMode === 'aml' && Boolean(profile.boundModelId))
  if (!lineageKind) return { scene: fallback, channelId, hybrid: false }
  if (!profile.sceneId || !profile.sceneVersion) throw new Error('TWIN_CHANNEL_SCENE_LINEAGE_REQUIRED')
  const row = createTwinRepo(getAmlRuntime().db).getScene(profile.sceneId, profile.sceneVersion)
  if (!row) throw new Error('TWIN_CHANNEL_SCENE_NOT_FOUND')
  const rawScene = JSON.parse(row.contractJson) as SceneWithDraftMetadata
  parseSceneContract(rawScene)
  assertFrozenScene(rawScene)
  const persisted = rawScene
  const supplied = jsonArg<Record<string, unknown>>(args, 'scene_json')
  if (supplied) {
    const suppliedParsed = parseSceneContract(supplied)
    if (sceneContractHash(suppliedParsed) !== row.contractHash) throw new Error('TWIN_SCENE_HASH_MISMATCH')
  }
  return { scene: persisted, channelId, hybrid: true }
}

export async function toolTwinProviderCatalog(_agentId: string, args: Record<string, unknown> = {}): Promise<HostToolResult> {
  try {
    const registry = getTwinProviderRegistry()
    const filter = typeof args.scene_kind === 'string' && args.scene_kind.trim() ? { sceneKind: args.scene_kind.trim() } : {}
    return ok(JSON.stringify({ apiVersion: 'twin-provider.v1', providers: registry.listProviders(filter), scenePacks: registry.listScenePacks(), solverAdapters: registry.listSolverAdapters() }, null, 2))
  }
  catch (err) {
    return fail(`Twin Provider 目录读取失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

function boundSceneNodes(agentId: string): NodeSemanticInput[] {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const daq = getDaqNodeRepo()
  const dcw = getDcwController()
  const recipes = getDcwRecipeRepo()
  const out: NodeSemanticInput[] = []
  const seen = new Set<string>()
  const pushDcw = (nodeId: string, paramWindow?: { min?: number, max?: number }, evidence: string[] = []) => {
    if (seen.has(nodeId)) return
    const node = dcw.byId(nodeId)
    if (!node) return
    seen.add(nodeId)
    // 量程 = 节点量程 ∩ 配方参数工艺窗口(两者都有才收窄;窗口缺失取节点量程)
    const min = paramWindow?.min != null && node.min != null ? Math.max(node.min, paramWindow.min) : (node.min ?? paramWindow?.min)
    const max = paramWindow?.max != null && node.max != null ? Math.min(node.max, paramWindow.max) : (node.max ?? paramWindow?.max)
    out.push({ nodeId: node.id, kind: 'dcw', name: node.name, physicalMeaning: node.semantics ?? node.name, unit: node.unit, min, max, maxStep: Math.max(Math.abs(max - min) * 0.02, 0.001), lineId: node.lineId, protocol: node.driver, writable: true, evidence: [...evidence, node.semantics ?? '', node.name, node.templateRef].filter(Boolean) })
  }
  for (const binding of bindings) {
    if (binding.kind === 'daq') {
      const node = daq.byId(binding.nodeId)
      if (!node) continue
      if (seen.has(node.id)) continue
      seen.add(node.id)
      out.push({ nodeId: node.id, kind: 'daq', name: node.name, physicalMeaning: node.semantics ?? node.name, unit: node.unit, min: node.min, max: node.max, lineId: node.lineId, protocol: node.driver, evidence: [node.semantics ?? '', node.templateKey].filter(Boolean) })
    }
    else if (binding.kind === 'recipe') {
      // 权限模型 v2 配方展开(2026-10-05 闭环修复):配方绑定 = 配方参数面授权,
      // 参数节点(dcw)以 kind='dcw'/writable 进入发现面 —— 否则 hybrid 频道
      // (只有 daq+recipe 绑定)永远 SCENE_NO_CONTROLS,寻优闭环断在第一步。
      const recipe = recipes.byId(binding.nodeId)
      if (!recipe) continue
      for (const param of recipe.params) {
        pushDcw(param.nodeId, { min: param.min, max: param.max }, [`配方「${recipe.name}」v${recipe.version ?? 1} 参数(工艺窗口)`])
      }
    }
    else {
      pushDcw(binding.nodeId)
    }
  }
  return out
}

export async function toolTwinSceneDiscover(agentId: string, args: Record<string, unknown> = {}): Promise<HostToolResult> {
  try {
    const nodes = boundSceneNodes(agentId)
    if (!nodes.length) return fail('尚未绑定 DAQ/DCW 节点，无法执行场景发现。请先绑定当前作业场景节点。')
    const result = discoverSceneNodes(nodes)
    return ok(JSON.stringify({ scene_kind: String(args.scene_kind ?? 'unknown'), nodeCount: nodes.length, counts: result.counts, nodes: result.nodes }, null, 2))
  }
  catch (err) {
    return fail(`场景发现失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinSceneCompile(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const sceneId = String(args.scene_id ?? '').trim()
    const lineId = String(args.line_id ?? '').trim()
    if (!sceneId || !lineId) return fail('scene_id 和 line_id 必填。')
    const nodes = boundSceneNodes(agentId).filter(node => !args.node_ids || (Array.isArray(args.node_ids) && args.node_ids.map(String).includes(node.nodeId)))
    const draft = compileSceneDraft({ sceneId, sceneVersion: String(args.scene_version ?? '0.1.0-draft'), lineId, productId: args.product_id ? String(args.product_id) : undefined, recipeId: args.recipe_id ? String(args.recipe_id) : undefined, prompt: args.prompt ? String(args.prompt) : undefined, createdBy: agentId, nodes, physicsProfileId: args.physics_profile_id ? String(args.physics_profile_id) : undefined, objectiveProfileIds: Array.isArray(args.objective_profile_ids) ? args.objective_profile_ids.map(String) : undefined, freeze: false })
    const repo = createTwinRepo(getAmlRuntime().db)
    repo.upsertScene(draft, agentId)
    const path = await persistTwinArtifact('scenes', `${draft.sceneId}-${draft.sceneVersion}`, draft)
    return ok(`SceneContract Draft 已生成\n  scene_id: ${draft.sceneId}\n  scene_version: ${draft.sceneVersion}\n  contract_hash: ${draft.draftMeta.contractHash}\n  status: ${draft.draftMeta.status}\n  controls: ${draft.controls.length}\n  states: ${draft.states.length}\n  targets: ${draft.observations.filter(x => x.role === 'target').length}\n  guards: ${draft.guards.length}\n  artifact: ${path}\n  注意：首次训练/上线前必须由用户确认并冻结 SceneContract；当前仅为 draft。`)
  }
  catch (err) {
    return fail(`SceneContract 编译失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinSceneFreeze(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const sceneId = String(args.scene_id ?? '').trim()
    const sceneVersion = String(args.scene_version ?? '').trim()
    const approvedBy = String(args.approved_by ?? agentId).trim()
    const confirmation = String(args.confirmation ?? '').trim()
    if (!sceneId || !sceneVersion) return fail('scene_id 和 scene_version 必填。')
    if (confirmation !== 'USER_CONFIRMED_SCENE_CONTRACT') return fail('冻结被拒绝：必须先完成用户确认，并传入 confirmation=USER_CONFIRMED_SCENE_CONTRACT。')
    const repo = createTwinRepo(getAmlRuntime().db)
    const frozen = repo.freezeScene(sceneId, sceneVersion, approvedBy, args.expected_hash ? String(args.expected_hash) : undefined)
    const path = await persistTwinArtifact('scenes', `${sceneId}-${sceneVersion}-frozen`, frozen)
    recordOps({ actor: agentId, actorName: agentId, actorKind: 'agent', action: 'twin.scene.freeze', kind: 'write', summary: `SceneContract ${sceneId}@${sceneVersion} 已冻结`, targetKind: 'twin_scene', targetId: `${sceneId}@${sceneVersion}` })
    return ok(JSON.stringify({ sceneId, sceneVersion, status: frozen.status, contractHash: frozen.contractHash, approvedBy: frozen.approvedBy, approvedAt: frozen.approvedAt, artifact: path, next: '允许生成 PhysicsSpec 并进入物理校准；SceneContract 变更必须新建版本。' }, null, 2))
  }
  catch (err) {
    return fail(`SceneContract 冻结失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

function physicsSpecArg(args: Record<string, unknown>): unknown {
  return jsonArg(args, 'physics_spec') ?? jsonArg(args, 'spec_json')
}

export async function toolTwinPhysicsSpecValidate(_agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const input = physicsSpecArg(args)
    if (!input) return fail('physics_spec 必填。')
    const result = validatePhysicsSpec(input)
    return ok(JSON.stringify({ apiVersion: 'physics-spec.v1', valid: result.valid, errors: result.errors, warnings: result.warnings, issues: result.issues, spec: result.spec ?? null }, null, 2))
  }
  catch (err) {
    return fail(`PhysicsSpec 校验失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinPhysicsSpecCompile(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const input = physicsSpecArg(args)
    if (!input) return fail('physics_spec 必填。')
    const checked = validatePhysicsSpec(input)
    if (!checked.valid || !checked.spec) return fail(JSON.stringify({ apiVersion: 'physics-spec.v1', valid: false, errors: checked.errors, warnings: checked.warnings, issues: checked.issues }, null, 2))
    const sceneInput = jsonArg<Record<string, unknown>>(args, 'scene_json')
    if (!sceneInput) return fail('physics_spec 编译前必须提供已冻结 scene_json。')
    const scene = assertFrozenScene(sceneInput)
    if (checked.spec.sceneId !== scene.sceneId) return fail(`PhysicsSpec 场景不匹配: spec=${checked.spec.sceneId}, scene=${scene.sceneId}`)
    const provider = compileDeclarativeProvider(checked.spec)
    const artifact = { apiVersion: 'physics-spec.v1', kind: 'declarative-provider-candidate', sceneId: scene.sceneId, sceneVersion: scene.sceneVersion, providerId: provider.manifest.physicsModelId, providerVersion: provider.manifest.version, sourceHash: provider.manifest.sourceHash, spec: checked.spec, manifest: provider.manifest, compiledBy: agentId, compiledAt: new Date().toISOString(), status: 'candidate_not_registered' }
    const path = await persistTwinArtifact('physics-spec', `${checked.spec.modelId}-${provider.manifest.sourceHash ?? sha256(checked.spec)}`, artifact)
    return ok(JSON.stringify({ ...artifact, artifact: path, next: '候选 Provider 仍须通过 Registry 注册、Replay/health、物理校准、AML Hybrid Gate；此工具不会直接切换 production。' }, null, 2))
  }
  catch (err) {
    return fail(`PhysicsSpec 编译失败:${err instanceof Error ? err.message : String(err)}`)
  }
}
export async function toolTwinSceneRead(_agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const defaultScene = defaultInjectionScene('twin-scene-tool')
  const supplied = jsonArg<Record<string, unknown>>(args, 'scene_json')
  let scene = supplied ? parseSceneContract(supplied) : defaultScene
  const sceneId = String(args.scene_id ?? scene.sceneId)
  if (!supplied && sceneId !== scene.sceneId) {
    const pack = getTwinProviderRegistry().listScenePacks().find(item => item.sceneKind === sceneId)
    if (pack?.compile) scene = parseSceneContract(await pack.compile({ userPrompt: String(args.user_prompt ?? ''), nodeCatalog: [], lineContext: {} }))
  }
  if (sceneId !== scene.sceneId) return fail(`场景契约未提供: scene_id=${sceneId}；请先调用 twin_provider_catalog，或通过 scene_json 注入场景契约。`)
  return ok(`场景契约 ${scene.sceneId}@${scene.sceneVersion}\n${JSON.stringify(scene, null, 2)}\n\n控制策略：recommendation-only；模型门禁未通过时只能 safe_small_step，禁止直接 DCW。\n快照前置：scene 的 observations/states 必须带 nodeId，且与 Agent 已绑定的真实 DAQ 节点一致；内置默认场景不带 nodeId，直接调用只会在 TwinSnapshot 里得到 fresh=false 并在 VirtualTrial 抛 SNAPSHOT_STALE —— 请用 scene_json 注入带 nodeId 的场景契约。`)
}

async function autoDaqSamples(agentId: string, scene: SceneContract, nowMs: number, freshnessMaxMs: number): Promise<Array<{ nodeId: string, at: number, value: number, sequence?: string }>> {
  const required = [...scene.observations, ...scene.states]
    .map(item => item.nodeId)
    .filter((nodeId): nodeId is string => Boolean(nodeId))
  const daqBindings = new Set(getAgentNodeBindingRepo().byAgent(agentId).filter(binding => binding.kind === 'daq').map(binding => binding.nodeId))
  const missingBindings = required.filter(nodeId => !daqBindings.has(nodeId))
  if (missingBindings.length > 0) throw new Error(`AUTO_DAQ_UNBOUND:${missingBindings.join(',')}`)
  const samples: Array<{ nodeId: string, at: number, value: number, sequence?: string }> = []
  for (const nodeId of required) {
    const points = await getDaqController().samples(nodeId, { fromMs: nowMs - freshnessMaxMs, toMs: nowMs, bucketMs: 1000, limit: 64 }) as Array<{ at?: number, value?: number, avg?: number }>
    const latest = points
      .map(point => ({ at: Number(point.at), value: Number(point.value ?? point.avg) }))
      .filter(point => Number.isFinite(point.at) && Number.isFinite(point.value))
      .sort((a, b) => a.at - b.at)
      .at(-1)
    if (!latest) throw new Error(`AUTO_DAQ_SAMPLE_MISSING:${nodeId}`)
    samples.push({ nodeId, at: latest.at, value: latest.value, sequence: `daq:${nodeId}:${latest.at}` })
  }
  return samples
}

export async function toolTwinSnapshotCreate(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const requestedScene = parseSceneContract(jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-snapshot-tool'))
    const authoritative = authoritativeSceneForAgent(agentId, args, requestedScene)
    const scene = authoritative.scene
    const flags = amlTwinFeatureFlags()
    if (authoritative.hybrid && !flags.trialEnabled) return fail('AML Twin trial/snapshot 功能开关已关闭。')
    const channelId = authoritative.channelId ?? String(args.channel_id ?? '').trim()
    if (!channelId) return fail('channel_id 必填；生产 TwinSnapshot 必须绑定 Channel。')
    const twinRepo = createTwinRepo(getAmlRuntime().db)
    const nowMs = Number(args.now_ms) || Date.now()
    const freshnessMaxMs = Number(args.freshness_max_ms) || 60_000
    const bindingSnapshot = authoritative.hybrid
      ? createNodeBindingSnapshot({ channelId, createdBy: agentId, agentId, scene, lineId: scene.lineId, productId: scene.productId, recipeId: scene.recipeId, nowMs, requireFrozenScene: true })
      : undefined
    const suppliedSamples = jsonArg<Array<{ nodeId: string, at: number, value: number, sequence?: string }>>(args, 'samples', []) ?? []
    if (authoritative.hybrid && args.auto_daq !== true) return fail('Hybrid Twin 生产快照必须由服务端 bound DAQ 采集：请传 auto_daq=true；不接受 Agent 自报 samples。')
    const samples = args.auto_daq === true || suppliedSamples.length === 0
      ? await autoDaqSamples(agentId, scene, nowMs, freshnessMaxMs)
      : suppliedSamples
    // 控制值服务端化(2026-10-05 方案 D):controls 缺省时由 dcw 节点现值/当前设定填充,
    // 消除 Agent 自报基线;显式传入的 controls 仍被尊重(便于 what-if 假设检验)。
    const suppliedControls = jsonArg<Record<string, number>>(args, 'controls', {}) ?? {}
    const controls: Record<string, number> = { ...suppliedControls }
    for (const control of scene.controls ?? []) {
      const key = String(control.id ?? control.nodeId ?? '')
      if (!key || controls[key] != null) continue
      const node = control.nodeId ? getDcwController().byId(control.nodeId) : undefined
      if (node && typeof node.value === 'number') controls[key] = node.value
      else if (node && typeof node.readValue === 'number') controls[key] = node.readValue
    }
    const snapshot = createTwinSnapshot({
      scene,
      frozenScene: authoritative.hybrid ? scene : undefined,
      channelId,
      createdBy: agentId,
      phase: String(args.phase ?? 'holding'),
      controls,
      states: jsonArg<Record<string, number>>(args, 'states', {}) ?? {},
      disturbances: jsonArg<Record<string, number>>(args, 'disturbances', {}) ?? {},
      samples,
      bindingSnapshot,
      nowMs,
      freshnessMaxMs,
      strict: authoritative.hybrid,
      requireBindingSnapshot: authoritative.hybrid,
      requireFrozenScene: authoritative.hybrid,
    })
    twinRepo.insertSnapshot(snapshot)
    const path = await persistTwinArtifact('snapshots', snapshot.snapshotId, snapshot)
    recordOps({ actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent', action: 'aml.twin.snapshot_create', kind: 'aml' as 'system', summary: `创建 TwinSnapshot ${snapshot.snapshotId}`, targetKind: 'aml_twin_snapshot', targetId: snapshot.snapshotId, lineId: scene.lineId, productId: scene.productId, recipeId: scene.recipeId })
    const quality = snapshot.dataQuality
    // 全部必需节点都没有样本(watermark=0)时不是"数据不新鲜",而是场景映射/绑定配置错了:
    // 旧行为只回 fresh=false,调用方要到 VirtualTrial 才看到 SNAPSHOT_STALE(实测踩过)。
    const requiredCount = [...scene.observations, ...scene.states].filter(v => v.nodeId).length
    if (snapshot.daqWatermark <= 0) {
      const missing = requiredCount === 0
        ? '场景 observations/states 没有任何 nodeId(内置默认场景即如此)'
        : `以下节点没有可用样本: ${quality.staleNodeIds.join(', ')}`
      return fail(`TwinSnapshot 创建失败:无可用 DAQ 样本(watermark=0)。${missing}。请用 scene_json 把场景观测/状态映射到已绑定的真实 DAQ 节点,并确认产线在跑。\n  snapshot_id: ${snapshot.snapshotId}\n  artifact: ${path}`)
    }
    return ok(`TwinSnapshot 已创建\n  source: ${args.auto_daq === true || suppliedSamples.length === 0 ? 'bound DAQ' : 'caller samples (legacy/test)'}\n  snapshot_id: ${snapshot.snapshotId}\n  hash: ${snapshot.snapshotHash}\n  fresh: ${quality.fresh}\n  completeness: ${quality.completeness}\n  stale_nodes: ${quality.staleNodeIds.length ? quality.staleNodeIds.join(', ') : '(none)'}\n  artifact: ${path}`)
  }
  catch (err) {
    return fail(`TwinSnapshot 创建失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinTrialRun(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const requestedScene = (jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-trial-tool')) as ReturnType<typeof defaultInjectionScene>
    const authoritative = authoritativeSceneForAgent(agentId, args, requestedScene)
    const scene = authoritative.scene
    if (authoritative.hybrid && !amlTwinFeatureFlags().trialEnabled) return fail('AML Twin trial 功能开关已关闭。')
    const twinRepo = createTwinRepo(getAmlRuntime().db)
    const snapshotId = String(args.snapshot_id ?? '').trim()
    const snapshot = (authoritative.hybrid ? (snapshotId ? twinRepo.getSnapshot(snapshotId) : null) : (jsonArg<Record<string, unknown>>(args, 'snapshot_json') as never)) as never
    if (!snapshot) return fail(authoritative.hybrid ? 'Hybrid Twin VirtualTrial 必须提供已持久化 snapshot_id；禁止直接注入 snapshot_json。' : 'snapshot_json 必填；必须使用当前 DAQ 生成的 TwinSnapshot，禁止 Agent 伪造执行状态。')
    if (authoritative.hybrid) {
      const bindingSnapshot = createNodeBindingSnapshot({ channelId: authoritative.channelId!, createdBy: agentId, agentId, scene, lineId: scene.lineId, productId: scene.productId, recipeId: scene.recipeId, requireFrozenScene: true })
      assertTwinSnapshot(snapshot as unknown, { scene, frozenScene: scene, bindingSnapshot, channelId: authoritative.channelId, expectedBindingSnapshotHash: bindingSnapshot.snapshotHash, requireFresh: true, requireBindingSnapshot: true, requireFrozenScene: true })
    }
    // 形状校验:传半截 JSON / 工具结果信封 / 纯字符串时旧行为是原生 TypeError
    // (Cannot read properties of undefined (reading 'fresh')),调用方看不出该怎么修。
    const snap = snapshot as { dataQuality?: { fresh?: boolean }, snapshotHash?: string, snapshotId?: string }
    if (!snap.dataQuality || typeof snap.dataQuality.fresh !== 'boolean' || !snap.snapshotId) {
      return fail('snapshot_json 不是 TwinSnapshot 工件:缺少 snapshotId/dataQuality。请先调用 twin_snapshot_create,并把其 artifact 文件的 JSON 原文整段回传(不要传工具结果文本或截断片段)。')
    }
    if (!snap.snapshotHash) return fail('snapshot_json 缺少 snapshotHash(快照被篡改或截断),拒绝执行 VirtualTrial。')
    const requestedModelId = String(args.model_id ?? '').trim()
    const ref = await rolloutProviderFor(agentId, scene, snap as unknown as TwinSnapshot, requestedModelId || undefined)
    const baseline = jsonArg<Record<string, number>>(args, 'baseline_controls', {}) ?? {}
    const candidate = jsonArg<Array<Record<string, number>>>(args, 'candidate_controls', []) ?? []
    const objective = jsonArg<Record<string, unknown>>(args, 'objective', {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: agentId, objectiveId: 'weight-quality', targets: { weight: 32.5 }, weights: { weight: 1 }, controlCosts: {}, horizonSteps: candidate.length || 4, trustRegion: {},
    }) as never
    // 模型驱动 rollout:平台侧集成 UQ(coverage 来自训练工件,而非 Agent 自报);
    // 传 thunk 由 runVirtualTrial 在 rollout 后解析。物理_only 保留调用方透传(旧行为)。
    const uncertainty = ref.modelBacked && ref.uncertainty
      ? ref.uncertainty
      : jsonArg(args, 'uncertainty') as never
    const trial = await runVirtualTrial({ scene, snapshot: snap as unknown as TwinSnapshot, modelId: requestedModelId || ref.modelId, modelHash: ref.modelHash, objective, baselineControls: baseline, candidateControls: candidate, provider: ref.rollout, uncertainty, createdBy: agentId })
    const certificate = issueRecommendationCertificate(trial, agentId, ref.modelHash, sha256(objective))
    // Trial is also a valid first entry point for external ScenePacks. Persist
    // the immutable SceneContract before the FK-backed trial row.
    twinRepo.upsertScene(scene, agentId)
    twinRepo.insertTrial(trial, requestedModelId || ref.modelId)
    if (certificate) twinRepo.insertRecommendation(certificate, agentId)
    const path = await persistTwinArtifact('trials', trial.trialId, { trial, certificate })
    ref.release()
    return ok(`VirtualTrial 已完成(candidateExecuted=false)
  trial_id: ${trial.trialId}
  rollout_model: ${requestedModelId || ref.modelId}${ref.modelBacked ? '(训练模型驱动:物理主干+有界残差集成)' : '(物理 provider 驱动;传 model_id 可用训练模型 rollout)'}
  uq: coverage=${Number(trial.uncertainty.coverage).toFixed(3)} members=${trial.uncertainty.ensembleSize} ood=${trial.outOfDistribution.accepted ? 'accepted' : `rejected(${trial.outOfDistribution.rejectCode})`}
  constraints_passed: ${trial.constraintResults.every(c => c.passed)}
  improvement: ${trial.baselineComparison.improvement}
  recommendation_id: ${certificate?.recommendationId ?? '(未签发：门禁未通过或无收益)'}
  artifact: ${path}
  控制路径: recommendation-only，未调用 DCW。`)
  }
  catch (err) {
    return fail(`VirtualTrial 失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolMpcOptimize(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const requestedScene = (jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-mpc-tool')) as ReturnType<typeof defaultInjectionScene>
    const authoritative = authoritativeSceneForAgent(agentId, args, requestedScene)
    const scene = authoritative.scene
    if (authoritative.hybrid && !amlTwinFeatureFlags().mpcEnabled) return fail('AML Twin MPC 功能开关已关闭。')
    const baseline = jsonArg<Record<string, number>>(args, 'baseline_controls', {}) ?? {}
    const modelId = String(args.model_id ?? '').trim()
    let snapshot: TwinSnapshot | undefined
    let objective = jsonArg<ObjectiveProfile>(args, 'objective')
    if (authoritative.hybrid) {
      const channelId = authoritative.channelId!
      const snapshotId = String(args.snapshot_id ?? '').trim()
      if (!snapshotId) return fail('Hybrid Twin MPC 必须提供已持久化 snapshot_id，禁止以自由 JSON 代替实时快照。')
      snapshot = createTwinRepo(getAmlRuntime().db).getSnapshot(snapshotId) ?? undefined
      if (!snapshot) return fail(`TwinSnapshot 不存在:${snapshotId}`)
      const bindingSnapshot = createNodeBindingSnapshot({ channelId, createdBy: agentId, agentId, scene, lineId: scene.lineId, productId: scene.productId, recipeId: scene.recipeId, requireFrozenScene: true })
      assertTwinSnapshot(snapshot, { scene, frozenScene: scene, bindingSnapshot, channelId, expectedBindingSnapshotHash: bindingSnapshot.snapshotHash, requireFresh: true, requireBindingSnapshot: true, requireFrozenScene: true })
      objective ??= getChannelTwinProfile(channelId).objective as unknown as ObjectiveProfile
    }
    const targets = objective?.targets ?? Object.fromEntries(scene.observations.filter(v => v.role === 'target').map(v => [v.id, 0]))
    const weights = objective?.weights ?? Object.fromEntries(Object.keys(targets).map(key => [key, 1]))
    const objectiveProfile: ObjectiveProfile = objective ?? {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: agentId, objectiveId: 'scene-default', targets, weights, controlCosts: {}, horizonSteps: Number(args.horizon_steps) || 4, trustRegion: {},
    }
    const providerRef = await rolloutProviderFor(agentId, scene, (snapshot ?? { stateEstimate: {}, controlValues: baseline, disturbances: {}, snapshotId: '', snapshotHash: '', dataQuality: { fresh: true } }) as TwinSnapshot, modelId || undefined)
    const rollout = providerRef.rollout
    // 升档判定跟随实际生效的模型:显式 model_id 或自动投用选中的 production 模型,
    // 否则「投用后自动 precise_search」永远不触发(modelReady 只看显式 model_id)。
    const effectiveModelId = modelId || (providerRef.modelBacked ? providerRef.modelId : '')
    const modelRow = effectiveModelId ? getAmlRuntime().repo.model.get(effectiveModelId) : null
    let modelReady = false
    if (modelRow && (modelRow.stage === 'shadow' || modelRow.stage === 'production')) {
      try {
        const metrics = JSON.parse(modelRow.metricsJson || '{}') as Record<string, unknown>
        const twin = metrics.twinEligibility as Record<string, unknown> | undefined
        modelReady = twin?.recommendationEligible === true && twin?.uqPassed === true && twin?.oodPassed === true && twin?.physicsPassed === true
      }
      catch { modelReady = false }
    }
    const candidates = smallStepCandidates(scene, baseline)
    const mode = modelReady ? 'precise_search' : 'safe_small_step'
    const selected = modelReady ? candidates : candidates.slice(0, Math.min(3, candidates.length))
    const horizon = Number(args.horizon_steps) || objectiveProfile.horizonSteps || 4
    // 模型驱动 rollout 的平台侧集成 UQ(coverage 来自训练工件);物理_only 走旧行为
    const trialUncertainty = providerRef.modelBacked && providerRef.uncertainty ? providerRef.uncertainty : undefined
    const results = []
    for (const candidate of selected) {
      if (authoritative.hybrid && snapshot) {
        const trial = await runVirtualTrial({ scene, snapshot, modelId: modelId || providerRef.modelId, modelHash: providerRef.modelHash, objective: objectiveProfile, baselineControls: baseline, candidateControls: Array.from({ length: horizon }, () => candidate), provider: rollout, uncertainty: trialUncertainty as never, createdBy: agentId })
        results.push({ candidate, cost: trial.baselineComparison.candidateCost, constraintsPassed: trial.constraintResults.every(c => c.passed), constraints: trial.constraintResults, trial })
        continue
      }
      const initial = rollout.initialize({ stateEstimate: {}, controlValues: baseline })
      const trajectory = await rollout.rollout(initial, Array.from({ length: horizon }, () => candidate), {})
      const last = trajectory.steps.at(-1)?.observations ?? {}
      const cost = Object.entries(objectiveProfile.targets).reduce((sum, [key, target]) => sum + (objectiveProfile.weights[key] ?? 1) * ((last[key] ?? 0) - target) ** 2, 0)
      const constraints = rollout.evaluateConstraints(scene, trajectory)
      results.push({ candidate, cost, constraintsPassed: constraints.every((c: { passed: boolean }) => c.passed), constraints })
    }
    const passed = results.filter(x => x.constraintsPassed).sort((a, b) => a.cost - b.cost)
    const best = passed[0]
    let recommendationId: string | null = null
    let trialId: string | null = null
    if (authoritative.hybrid && best && 'trial' in best && best.trial) {
      const trial = best.trial
      trialId = trial.trialId
      const certificate = issueRecommendationCertificate(trial, agentId, providerRef.modelHash, sha256(objectiveProfile))
      const twinRepo = createTwinRepo(getAmlRuntime().db)
      twinRepo.insertTrial(trial, modelId || providerRef.modelId)
      if (certificate) {
        twinRepo.insertRecommendation(certificate, agentId)
        recommendationId = certificate.recommendationId
      }
    }
    const report = { modelId: modelId || null, rolloutModel: providerRef.modelId, rolloutModelBacked: providerRef.modelBacked, mode, modelReady, snapshotId: snapshot?.snapshotId ?? null, candidatesEvaluated: selected.length, bestCandidate: best?.candidate ?? null, bestCost: best?.cost ?? null, trialId, recommendationId, recommendationOnly: true, preciseSearchAllowed: modelReady && passed.length > 0 }
    const path = await persistTwinArtifact('mpc', `run-${Date.now().toString(36)}`, report)
    providerRef.release()
    return ok(`MPC recommendation-only 试验完成
${JSON.stringify(report, null, 2)}
artifact: ${path}
${modelReady ? '模型门禁已通过，可进行更精确的候选搜索，但仍不能直接写 DCW。' : '模型门禁未通过，仅执行 safe_small_step 小步试探；先收集 DAQ 数据，不执行精确搜索。'}`)
  }
  catch (err) {
    return fail(`MPC 优化失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 工具:twin_bayes_optimize —— AML 模式贝叶斯寻优(绑定模型 surrogate + UCB 采集)。
 * 仅工艺优化 Channel 的 aml 模式(dispatch 门控);与 mpc_optimize 的区别:
 * 多轮收敛搜索(每轮围绕当前最优邻域生成候选,UCB=μ-κ·σ 权衡利用与探索),
 * 产出收敛轨迹(供界面渲染)与最终受治理推荐(证书/recommendationOnly)。
 */
export async function toolTwinBayesOptimize(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const requestedScene = (jsonArg(args, 'scene_json') ?? defaultInjectionScene('twin-bayes-tool')) as ReturnType<typeof defaultInjectionScene>
    const authoritative = authoritativeSceneForAgent(agentId, args, requestedScene)
    const scene = authoritative.scene
    const baseline = jsonArg<Record<string, number>>(args, 'baseline_controls', {}) ?? {}
    const modelId = String(args.model_id ?? '').trim()
    let snapshot: TwinSnapshot | undefined
    let objective = jsonArg<ObjectiveProfile>(args, 'objective')
    if (authoritative.hybrid) {
      const channelId = authoritative.channelId!
      const snapshotId = String(args.snapshot_id ?? '').trim()
      if (!snapshotId) return fail('Hybrid Twin 贝叶斯寻优必须提供已持久化 snapshot_id。')
      snapshot = createTwinRepo(getAmlRuntime().db).getSnapshot(snapshotId) ?? undefined
      if (!snapshot) return fail(`TwinSnapshot 不存在:${snapshotId}`)
      const bindingSnapshot = createNodeBindingSnapshot({ channelId, createdBy: agentId, agentId, scene, lineId: scene.lineId, productId: scene.productId, recipeId: scene.recipeId, requireFrozenScene: true })
      assertTwinSnapshot(snapshot, { scene, frozenScene: scene, bindingSnapshot, channelId, expectedBindingSnapshotHash: bindingSnapshot.snapshotHash, requireFresh: true, requireBindingSnapshot: true, requireFrozenScene: true })
      objective ??= getChannelTwinProfile(channelId).objective as unknown as ObjectiveProfile
    }
    const targets = objective?.targets ?? Object.fromEntries(scene.observations.filter(v => v.role === 'target').map(v => [v.id, 0]))
    const weights = objective?.weights ?? Object.fromEntries(Object.keys(targets).map(key => [key, 1]))
    const objectiveProfile: ObjectiveProfile = objective ?? {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: agentId, objectiveId: 'scene-default', targets, weights, controlCosts: {}, horizonSteps: Number(args.horizon_steps) || 4, trustRegion: {},
    }
    const profile = authoritative.channelId ? getChannelTwinProfile(authoritative.channelId) : null
    const boundModelId = profile?.boundModelId ?? ''
    const effectiveRequested = modelId || boundModelId || undefined
    const providerRef = await rolloutProviderFor(agentId, scene, (snapshot ?? { stateEstimate: {}, controlValues: baseline, disturbances: {}, snapshotId: '', snapshotHash: '', dataQuality: { fresh: true } }) as TwinSnapshot, effectiveRequested)
    if (!providerRef.modelBacked) {
      return fail('贝叶斯寻优要求模型驱动 rollout:请先在 Channel 设置绑定通过门禁的 AML 模型(当前回退到物理 provider)。')
    }
    const scale = Math.max(1e-6, ...Object.values(objectiveProfile.targets).map(v => Math.abs(Number(v)) * 0.05))
    const kappa = Number(args.kappa) || 1.96
    const rounds = Math.min(10, Math.max(1, Number(args.rounds) || 4))
    const perRound = Math.min(20, Math.max(2, Number(args.candidates_per_round) || 6))
    const horizon = Number(args.horizon_steps) || objectiveProfile.horizonSteps || 4
    const trialUncertainty = providerRef.modelBacked && providerRef.uncertainty ? providerRef.uncertainty : undefined

    // 候选生成:围绕锚点的单变量 ±1/±2 步 + 双变量随机组合;全局去重防重复评估
    const controls = scene.controls
    const seen = new Set<string>([JSON.stringify(baseline)])
    let seed = rounds * 977 + perRound * 131 + controls.length
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const genCandidates = (anchor: Record<string, number>, count: number): Array<Record<string, number>> => {
      const out: Array<Record<string, number>> = []
      const push = (cand: Record<string, number>) => {
        const key = JSON.stringify(cand)
        if (!seen.has(key)) {
          seen.add(key)
          out.push(cand)
        }
      }
      for (const c of controls) {
        const cur = anchor[c.id] ?? 0
        const ms = c.maxStep || Math.abs(((c.max ?? 0) - (c.min ?? 0)) / 20)
        for (const k of [1, 2]) {
          for (const s of [1, -1]) {
            const v = Math.min(c.max ?? Infinity, Math.max(c.min ?? -Infinity, cur + s * ms * k))
            if (Math.abs(v - cur) > 1e-9) push({ ...anchor, [c.id]: v })
          }
        }
      }
      let guard = 0
      while (out.length < count && controls.length >= 2 && guard++ < count * 4) {
        const cand = { ...anchor }
        for (let n = 0; n < 2; n++) {
          const c = controls[Math.floor(rnd() * controls.length) % controls.length]!
          const cur = cand[c.id] ?? 0
          const ms = c.maxStep || Math.abs(((c.max ?? 0) - (c.min ?? 0)) / 20)
          cand[c.id] = Math.min(c.max ?? Infinity, Math.max(c.min ?? -Infinity, cur + (rnd() < 0.5 ? 1 : -1) * ms * (1 + rnd())))
        }
        push(cand)
      }
      return out.slice(0, count)
    }

    const convergence: Array<{ round: number, evaluated: number, bestCost: number | null, ucbScore: number | null, bestCandidate: Record<string, number> | null }> = []
    let anchor: Record<string, number> = baseline
    let globalBest: { candidate: Record<string, number>, cost: number, trial?: unknown } | null = null
    for (let r = 1; r <= rounds; r++) {
      const cands = genCandidates(anchor, perRound)
      const results: Array<{ candidate: Record<string, number>, cost: number, score: number, constraintsPassed: boolean, trial?: unknown }> = []
      for (const candidate of cands) {
        if (authoritative.hybrid && snapshot) {
          const trial = await runVirtualTrial({ scene, snapshot, modelId: effectiveRequested || providerRef.modelId, modelHash: providerRef.modelHash, objective: objectiveProfile, baselineControls: baseline, candidateControls: Array.from({ length: horizon }, () => candidate), provider: providerRef.rollout, uncertainty: trialUncertainty as never, createdBy: agentId })
          const cost = trial.baselineComparison.candidateCost
          const sigmaN = Number(trial.uncertainty?.maxStd ?? 0) / scale
          results.push({ candidate, cost, score: cost - kappa * sigmaN, constraintsPassed: trial.constraintResults.every(c => c.passed), trial })
          continue
        }
        const initial = providerRef.rollout.initialize({ stateEstimate: {}, controlValues: baseline })
        const trajectory = await providerRef.rollout.rollout(initial, Array.from({ length: horizon }, () => candidate), {})
        const last = trajectory.steps.at(-1)?.observations ?? {}
        const cost = Object.entries(objectiveProfile.targets).reduce((sum, [key, target]) => sum + (objectiveProfile.weights[key] ?? 1) * ((last[key] ?? 0) - target) ** 2, 0)
        const constraints = providerRef.rollout.evaluateConstraints(scene, trajectory)
        results.push({ candidate, cost, score: cost, constraintsPassed: constraints.every((c: { passed: boolean }) => c.passed) })
      }
      const passed = results.filter(x => x.constraintsPassed).sort((a, b) => a.score - b.score)
      const roundBest = passed[0]
      convergence.push({ round: r, evaluated: cands.length, bestCost: roundBest?.cost ?? null, ucbScore: roundBest?.score ?? null, bestCandidate: roundBest?.candidate ?? null })
      if (roundBest && roundBest.cost < (globalBest?.cost ?? Infinity)) {
        globalBest = { candidate: roundBest.candidate, cost: roundBest.cost, trial: roundBest.trial }
        anchor = roundBest.candidate
      }
    }
    let recommendationId: string | null = null
    let trialId: string | null = null
    if (authoritative.hybrid && globalBest?.trial) {
      const trial = globalBest.trial as Awaited<ReturnType<typeof runVirtualTrial>>
      trialId = trial.trialId
      const certificate = issueRecommendationCertificate(trial, agentId, providerRef.modelHash, sha256(objectiveProfile))
      const twinRepo = createTwinRepo(getAmlRuntime().db)
      twinRepo.insertTrial(trial, effectiveRequested || providerRef.modelId)
      if (certificate) {
        twinRepo.insertRecommendation(certificate, agentId)
        recommendationId = certificate.recommendationId
      }
    }
    const report = {
      algorithm: 'surrogate_ucb', kappa, scale: Number(scale.toFixed(6)), rounds, perRound,
      boundModelId: boundModelId || null, modelId: effectiveRequested || null, rolloutModel: providerRef.modelId, rolloutModelBacked: providerRef.modelBacked,
      snapshotId: snapshot?.snapshotId ?? null, candidatesEvaluated: seen.size - 1,
      convergence, bestCandidate: globalBest?.candidate ?? null, bestCost: globalBest?.cost ?? null,
      trialId, recommendationId, recommendationOnly: true,
    }
    const path = await persistTwinArtifact('bayes', `run-${Date.now().toString(36)}`, report)
    providerRef.release()
    return ok(`贝叶斯寻优完成(surrogate+UCB,${rounds} 轮×≤${perRound} 候选)
${JSON.stringify(report, null, 2)}
artifact: ${path}
推荐仍为 recommendation-only:写入 DCW 须经治理审批。`)
  }
  catch (err) {
    return fail(`贝叶斯寻优失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinGateEvaluate(_agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const modelId = String(args.model_id ?? '').trim()
    if (!modelId) return fail('twin_gate_evaluate 必须提供 model_id；门禁指标只能来自平台作业/工件，不能由 Agent 自报。')
    const rt = getAmlRuntime()
    const model = rt.repo.model.get(modelId)
    if (!model) return fail(`模型不存在:${modelId}`)
    const metrics = JSON.parse(model.metricsJson || '{}') as Record<string, unknown>
    // 兼容两种存储形状:concludeJob 展平后平台指标在顶层,旧行嵌套于 platform.*
    const platform = (metrics.platform ?? metrics) as Record<string, unknown> | undefined
    const oneStepTest = platform?.oneStepTest as Record<string, unknown> | undefined
    const oneStepVal = platform?.oneStepVal as Record<string, unknown> | undefined
    const rolloutTest = platform?.rolloutTest as Record<string, unknown> | undefined
    if (!oneStepTest) return fail('平台权威 metrics.platform.oneStepTest 缺失：模型尚未完成 aml_eval.py，拒绝计算 Twin Gate。')
    const dataset = rt.repo.dataset.get(model.datasetId)
    if (!dataset) return fail('模型数据集不存在，拒绝计算 Twin Gate。')
    const oneStepTestNrmse = Number(oneStepTest.nrmse)
    const oneStepValNrmse = Number(oneStepVal?.nrmse)
    const valTestGap = Number.isFinite(oneStepValNrmse) && Math.abs(oneStepValNrmse) > 1e-9 ? Math.abs(oneStepTestNrmse - oneStepValNrmse) / Math.abs(oneStepValNrmse) : 1
    const rolloutTestNrmse = Number(rolloutTest?.nrmse ?? 1)
    const hybrid = metrics.hybrid as Record<string, unknown> | undefined
    const uncertainty = metrics.uncertainty as Record<string, unknown> | undefined
    const physics = metrics.physics as Record<string, unknown> | undefined
    const trialRows = rt.db.prepare('SELECT result_json AS resultJson FROM twin_trials WHERE twin_model_id = ? ORDER BY created_at DESC LIMIT 200').all(modelId) as Array<{ resultJson?: string }>
    const candidateTrials = trialRows.map((row) => {
      try {
        return JSON.parse(String(row.resultJson ?? '{}'))
      }
      catch {
        return null
      }
    }).filter(Boolean) as never[]
    const result = evaluateHybridGates({
      rows: dataset.rowCount,
      runs: dataset.runIds.length,
      oneStepTestNrmse,
      rolloutTestNrmse,
      valTestGap,
      calibrationRows: Number(hybrid?.calibrationRows ?? uncertainty?.calibrationRows ?? 0),
      calibrationCoverage: Number(hybrid?.calibrationCoverage ?? uncertainty?.coverage ?? 0),
      candidateTrials,
      physicsSolverFailureRate: Number(hybrid?.physicsFailureRate ?? physics?.solverFailureRate ?? 1),
    }, resolveAcceptanceProfile(String(args.scene_id ?? '') || undefined))
    const twinEligibility = {
      gatePassed: result.passed,
      recommendationEligible: result.passed,
      uqPassed: result.checks.some(c => c.id === 'G7_UQ_OOD') && result.checks.find(c => c.id === 'G7_UQ_OOD')?.passed === true,
      oodPassed: result.checks.find(c => c.id === 'G7_UQ_OOD')?.passed === true,
      physicsPassed: result.checks.find(c => c.id === 'G5_PHYSICS' || c.id === 'G5_PHYSICS_FAILURE')?.passed === true,
      evaluatedAt: new Date().toISOString(),
      source: 'platform_artifacts',
      datasetHash: dataset.sha256,
      modelId,
    }
    metrics.twinEligibility = twinEligibility
    // 影子证据(shadow→production 晋升的验收输入):场景级 Twin Gate 全过时,把平台权威
    // 证据(候选试验数/UQ 覆盖/门禁明细)落为 shadowEvidence —— 此前该字段只有验收读取
    // 没有任何写入者,production 晋升永远不可达;来源与时间戳可审计,不由 Agent 自报。
    if (result.passed) {
      const trialCount = result.checks.find(c => c.id === 'G6_CANDIDATE_COUNT')?.value
      const coverage = result.checks.find(c => c.id === 'G4_COVERAGE')?.value
      metrics.shadowEvidence = {
        passed: true,
        source: 'twin_gate_all_passed',
        basis: `场景级 Twin Gate G0-G7 全过(候选试验 ${String(trialCount ?? '?')} 条无硬违规,UQ coverage ${String(coverage ?? '?')})`,
        sceneId: String(args.scene_id ?? '') || undefined,
        evaluatedAt: twinEligibility.evaluatedAt,
      }
    }
    rt.db.prepare('UPDATE aml_models SET metrics_json = ? WHERE id = ?').run(JSON.stringify(metrics), modelId)
    return ok(JSON.stringify({ ...result, source: 'platform_artifacts', modelId, datasetId: model.datasetId, twinEligibility }, null, 2))
  }
  catch (err) {
    return fail(`Twin Gate 评估失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function toolTwinCalibrationRequest(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  try {
    const rt = getAmlRuntime()
    const result = requestCalibration(rt.db, {
      sceneId: String(args.scene_id ?? 'injection-hold-control'),
      lineId: String(args.line_id ?? ''),
      recipeId: String(args.recipe_id ?? ''),
      newRuns: Number(args.new_runs ?? 0),
      newRows: Number(args.new_rows ?? 0),
      driftScore: Number(args.drift_score ?? 0),
      errorScore: Number(args.error_score ?? 0),
      reason: String(args.reason ?? 'agent_requested'),
    }, DEFAULT_TWIN_CALIBRATION_POLICY, agentId)
    return ok(JSON.stringify({ ...result, policy: DEFAULT_TWIN_CALIBRATION_POLICY, next: result.accepted ? 'AgentTeam lead should dispatch data/calibration/training/evaluation tasks; production model remains unchanged.' : 'Collect more DAQ runs or wait for cooldown.' }, null, 2))
  }
  catch (err) {
    return fail(`持续校准请求失败:${err instanceof Error ? err.message : String(err)}`)
  }
}
