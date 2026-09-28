/**
 * Model-backed rollout provider:让**训练注册后的 hybrid 模型**直接驱动 VirtualTrial/MPC。
 *
 * 组成 = hybrid_manifest.json 里冻结(含校准后 θ)的 PhysicsSpec 声明式物理主干
 * + 残差集成 ONNX(默认 3 成员,平台 UQ 依据)。物理先走、残差只在 residualScale
 * 边界内修正目标观测(归一化域,与 predictor 服役路径同一数学);历史窗口按
 * persistence 语义维护(与 io_spec.assumptions 一致)。
 *
 * 这是"训练出的模型进入孪生闭环"的落实点:此前 trial/MPC 只拿 physics-only
 * provider,model_id 只是标签;现在 model_id 背后的真实工件参与每一次 rollout。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../../utils/errors'
import { parseIoSpec } from '../model-registry'
import { onnxSessionFor, ortRuntime, type IoSpec, type OrtSession } from '../predictor'
import { compileDeclarativeProvider } from './declarative-provider'
import { parsePhysicsSpec, type PhysicsSpec } from './physics-spec'
import type { AmlModelRow } from '../aml.repo'
import type { PhysicsState, PhysicsStepResult, PhysicsTrajectory } from './physics-runtime'
import type { RolloutProvider } from './trial-service'

interface HybridManifest {
  physicsSpec?: unknown
  residualScale?: number
  composition?: string
  physicsSpecHash?: string
  ensemble?: {
    members?: number
    files?: string[]
    calibrationCoverage?: number | null
    coverageTarget?: number
    calibrationRows?: number | null
  }
}

export interface ModelBackedUncertainty {
  /** 每步各目标归一化域的集成间最大标准差(与 residualScale 同量纲) */
  maxStdByStep: number[]
  /** 各成员最后一拍的目标预测(原始物理量纲;相对分歧对量纲不敏感) */
  memberPredictions: Array<Record<string, number>>
  calibrationCoverage: number | null
  coverageTarget: number
  members: number
}

export interface ModelSnapshotValues {
  stateEstimate: Record<string, number>
  controlValues: Record<string, number>
  disturbances: Record<string, number>
}

/**
 * 配方隔离守卫:模型的训练数据集 line/product/recipe 必须与场景谱系一致,
 * 不同配方的模型禁止驱动彼此的孪生 rollout(单一实现,工具层与验收共用)。
 */
export function assertModelSceneLineage(
  dataset: { lineId: string, productId: string, recipeId: string },
  scene: { lineId?: string, productId?: string, recipeId?: string },
): void {
  const mismatch: string[] = []
  if (scene.lineId && dataset.lineId !== scene.lineId) mismatch.push(`line ${dataset.lineId}≠${scene.lineId}`)
  if (scene.productId && dataset.productId !== scene.productId) mismatch.push(`product ${dataset.productId}≠${scene.productId}`)
  if (scene.recipeId && dataset.recipeId !== scene.recipeId) mismatch.push(`recipe ${dataset.recipeId}≠${scene.recipeId}`)
  if (mismatch.length > 0) {
    throw new AppError(409, 'TWIN_MODEL_SCENE_MISMATCH', `TWIN_MODEL_SCENE_MISMATCH:${mismatch.join(';')}(模型与场景/配方必须同谱系,禁止跨配方复用)`)
  }
}

type BaseProvider = ReturnType<typeof compileDeclarativeProvider>

export class ModelBackedHybridProvider implements RolloutProvider {
  readonly base: BaseProvider
  readonly spec: PhysicsSpec
  readonly io: IoSpec
  readonly hybridManifest: HybridManifest
  readonly model: AmlModelRow
  private readonly sessions: OrtSession[]
  private readonly aliases: Map<string, string>
  /** 训练期控制均值(按 varId);baseline 未提供全部控制输入时的回退先验,防 spec 求值 NaN */
  private readonly defaultControls: Record<string, number>
  private readonly residualScale: number
  private rawHistory: number[][] = []
  private readonly uncertainty: ModelBackedUncertainty

  private constructor(
    model: AmlModelRow,
    manifest: HybridManifest,
    sessions: OrtSession[],
    snapshot: ModelSnapshotValues,
  ) {
    this.model = model
    this.hybridManifest = manifest
    if (!manifest.physicsSpec) throw new AppError(409, 'AML_HYBRID_PHYSICS_MISSING', `模型 ${model.id} 缺少冻结 PhysicsSpec,拒绝把 residual 当完整预测`)
    this.spec = parsePhysicsSpec(manifest.physicsSpec)
    this.io = parseIoSpec(model) as unknown as IoSpec
    this.base = compileDeclarativeProvider(this.spec)
    this.residualScale = Math.abs(Number(manifest.residualScale ?? 0.25))
    this.aliases = new Map(this.spec.variables.filter(v => v.nodeId).map(v => [v.nodeId as string, v.id]))
    this.defaultControls = Object.fromEntries(this.io.controlNodes.map((node, j) => {
      const varId = this.aliases.get(node) ?? node
      return [varId, this.io.norm.u.mean[j] ?? 0]
    }))
    this.sessions = sessions
    this.uncertainty = {
      maxStdByStep: [],
      memberPredictions: [],
      calibrationCoverage: manifest.ensemble?.calibrationCoverage ?? null,
      coverageTarget: manifest.ensemble?.coverageTarget ?? 0.9,
      members: manifest.ensemble?.members ?? sessions.length,
    }
    this.primeHistory(snapshot)
  }

  /** 工厂:加载 manifest + 残差集成会话(会话经 predictor LRU 复用) */
  static async create(model: AmlModelRow, snapshot: ModelSnapshotValues): Promise<ModelBackedHybridProvider> {
    const manifestPath = join(model.path, 'hybrid_manifest.json')
    if (!existsSync(manifestPath)) {
      throw new AppError(409, 'AML_MODEL_NOT_HYBRID', `模型 ${model.id} 不是 hybrid 工件(缺 hybrid_manifest.json),不能作为孪生 rollout 模型`)
    }
    let manifest: HybridManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as HybridManifest
    }
    catch {
      throw new AppError(409, 'AML_HYBRID_MANIFEST_INVALID', `模型 ${model.id} 的 hybrid_manifest.json 无法解析`)
    }
    if (!ortRuntime()) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', '预测服务依赖 onnxruntime-node 未安装:执行 pnpm install(可选依赖)后重启')
    const files = manifest.ensemble?.files?.length ? manifest.ensemble.files : ['model.onnx']
    const sessions: OrtSession[] = []
    for (const [index, file] of files.entries()) {
      const path = join(model.path, file)
      if (!existsSync(path)) {
        if (index === 0) throw new AppError(410, 'AML_ARTIFACT_MISSING', `模型 ${model.id} 残差工件缺失(${file})`)
        continue
      }
      sessions.push(await onnxSessionFor(path, `${model.id}::${file}`))
    }
    return new ModelBackedHybridProvider(model, manifest, sessions, snapshot)
  }

  private valueForNode(node: string, snapshot: ModelSnapshotValues): number {
    const varId = this.aliases.get(node) ?? node
    const variable = this.spec.variables.find(v => v.id === varId)
    return snapshot.stateEstimate[varId]
      ?? snapshot.stateEstimate[node]
      ?? snapshot.controlValues[varId]
      ?? snapshot.controlValues[node]
      ?? snapshot.disturbances[varId]
      ?? snapshot.disturbances[node]
      ?? variable?.defaultValue
      ?? variable?.min
      ?? 0
  }

  private primeHistory(snapshot: ModelSnapshotValues): void {
    const row = this.io.allNodes.map(node => this.valueForNode(node, snapshot))
    this.rawHistory = Array.from({ length: this.io.historySteps }, () => [...row])
  }

  private normalizeWindow(): number[][] {
    const mx = this.io.norm.x.mean
    const sx = this.io.norm.x.std
    return this.rawHistory.map(row => row.map((v, j) => (v - (mx[j] ?? 0)) / (sx[j] ?? 1)))
  }

  private normalizeControls(controls: Record<string, number>, lastRow: number[]): number[] {
    return this.io.controlNodes.map((node, j) => {
      const varId = this.aliases.get(node) ?? node
      const raw = controls[varId] ?? controls[node] ?? lastRow[this.io.allNodes.indexOf(node)] ?? 0
      return (raw - (this.io.norm.u.mean[j] ?? 0)) / (this.io.norm.u.std[j] ?? 1)
    })
  }

  /** 残差集成前向:归一化窗口(末拍控制列替换为本拍控制,与 predictor 同口径)→ 各成员 residual */
  private async residualForward(historyNorm: number[][], controlsNorm: number[]): Promise<{ mean: number[], std: number[], members: number[][] }> {
    const H = this.io.historySteps
    const nAll = this.io.allNodes.length
    // 末拍控制列替换为本拍控制(predictor 服役路径同语义;否则残差看到的是上一拍控制)
    const window = historyNorm.map(row => [...row])
    const last = window[H - 1]
    if (last) {
      this.io.controlNodes.forEach((node, c) => {
        const j = this.io.allNodes.indexOf(node)
        if (j >= 0) last[j] = controlsNorm[c] ?? last[j]!
      })
    }
    const flat = new Float32Array(H * nAll)
    for (let i = 0; i < H; i++) {
      window[i]?.forEach((v, j) => {
        flat[i * nAll + j] = v
      })
    }
    const ort = ortRuntime()
    if (!ort) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', 'onnxruntime-node 不可用')
    const nTgt = this.io.targetNodes.length
    const perMember: number[][] = []
    for (const session of this.sessions) {
      const inpName = session.inputNames[0]
      if (!inpName) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', `残差 session 无输入名(模型 ${this.model.id})`)
      const outName = session.outputNames[0] ?? inpName
      const out = await session.run({ [inpName]: new ort.Tensor('float32', flat, [1, H, nAll]) })
      const data = Array.from((out[outName] as { data: ArrayLike<number> }).data) as number[]
      perMember.push(data.slice(0, nTgt))
    }
    const mean: number[] = []
    const std: number[] = []
    for (let t = 0; t < nTgt; t++) {
      const series = perMember.map(row => row[t] ?? 0)
      const mu = series.reduce((a, b) => a + b, 0) / Math.max(1, series.length)
      const variance = series.length > 1 ? series.reduce((a, b) => a + (b - mu) ** 2, 0) / series.length : 0
      mean.push(mu)
      std.push(Math.sqrt(variance))
    }
    return { mean, std, members: perMember }
  }

  initialize(snapshot: { stateEstimate: Record<string, number>, controlValues: Record<string, number> }): PhysicsState {
    return this.base.initialize(snapshot)
  }

  /** 模型驱动 rollout:物理主干 → 有界残差修正目标 → 历史窗口推进 */
  async rollout(initial: PhysicsState, controls: Array<Record<string, number>>, disturbances: Record<string, number> = {}): Promise<PhysicsTrajectory> {
    void disturbances
    let state = { ...initial }
    const steps: PhysicsStepResult[] = []
    const failures: string[] = []
    for (const control of controls) {
      // 控制输入并集:baseline/candidate 常只含被优化变量,物理方程引用其余控制时回退训练均值(否则 ref miss → NaN)
      const physics = this.base.step({ state, controls: { ...this.defaultControls, ...control }, disturbances, dtSec: this.spec.solver.dtSec })
      const lastRow = this.rawHistory[this.rawHistory.length - 1] ?? []
      // 目标物理值 → 归一化 → 加有界残差(与 predictor 服役路径同一数学)
      const my = this.io.norm.y.mean
      const sy = this.io.norm.y.std
      const yPhysNorm = this.io.targetNodes.map((node, t) => {
        const varId = this.aliases.get(node) ?? node
        const raw: number | undefined = physics.observations[varId] ?? physics.state[varId]
        if (raw === undefined || !Number.isFinite(raw)) {
          throw new AppError(409, 'AML_HYBRID_PHYSICS_OUTPUT_MISSING', `PhysicsSpec 未生成目标 ${node}(模型 ${this.model.id};常见原因:spec 方程求值得到非有限值 —— 检查 spec 引用的控制/状态变量是否都有输入)`)
        }
        return (raw - (my[t] ?? 0)) / (sy[t] ?? 1)
      })
      const controlsNorm = this.normalizeControls(control, lastRow)
      const { mean, std, members } = await this.residualForward(this.normalizeWindow(), controlsNorm)
      const boundedOf = (value: number | undefined): number => Math.max(-this.residualScale, Math.min(this.residualScale, value ?? 0))
      const correctedRaw = this.io.targetNodes.map((node, t) => (yPhysNorm[t]! + boundedOf(mean[t])) * (sy[t] ?? 1) + (my[t] ?? 0))
      const observations = { ...physics.observations }
      this.io.targetNodes.forEach((node, t) => {
        const varId = this.aliases.get(node) ?? node
        observations[varId] = correctedRaw[t]!
      })
      // 历史窗口推进(persistence:feature 持最后观测;control 取本拍;target 回填修正值;state 回填演化)
      const nextRow = [...lastRow]
      this.io.controlNodes.forEach((node) => {
        const pos = this.io.allNodes.indexOf(node)
        const varId = this.aliases.get(node) ?? node
        if (pos >= 0) nextRow[pos] = control[varId] ?? control[node] ?? nextRow[pos] ?? 0
      })
      this.io.targetNodes.forEach((node, t) => {
        const pos = this.io.allNodes.indexOf(node)
        if (pos >= 0) nextRow[pos] = correctedRaw[t]!
      })
      for (const variable of this.spec.variables) {
        if (variable.role !== 'state') continue
        const pos = this.io.allNodes.indexOf(variable.nodeId ?? variable.id)
        if (pos >= 0) nextRow[pos] = physics.state[variable.id] ?? nextRow[pos] ?? 0
      }
      this.rawHistory.push(nextRow)
      if (this.rawHistory.length > this.io.historySteps) this.rawHistory.shift()
      this.uncertainty.maxStdByStep.push(Math.max(...std, 0))
      // 每成员"本拍目标会是什么"(原始量纲,各自残差而非均值)——相对分歧评估的输入
      this.uncertainty.memberPredictions = members.map((row) => {
        const entry: Record<string, number> = {}
        this.io.targetNodes.forEach((node, t) => {
          entry[node] = (yPhysNorm[t]! + boundedOf(row[t])) * (sy[t] ?? 1) + (my[t] ?? 0)
        })
        return entry
      })
      const result: PhysicsStepResult = { state: physics.state, observations, guards: physics.guards }
      if ([...Object.values(result.state), ...Object.values(result.observations), ...Object.values(result.guards)].some(value => !Number.isFinite(value))) failures.push('HYBRID_NON_FINITE')
      for (const variable of this.spec.variables) {
        const value = result.state[variable.id] ?? result.observations[variable.id] ?? result.guards[variable.id]
        if (value !== undefined && ((variable.min !== undefined && value < variable.min) || (variable.max !== undefined && value > variable.max))) failures.push(`PHYSICS_BOUND:${variable.id}`)
      }
      state = physics.state
      steps.push(result)
    }
    return { steps, failures: [...new Set(failures)] }
  }

  evaluateConstraints(scene: Parameters<BaseProvider['evaluateConstraints']>[0], trajectory: Parameters<BaseProvider['evaluateConstraints']>[1]) {
    // 场景约束 id ↔ spec 变量 id 翻译:骨架去重后 spec id 可能与场景变量 id 不同
    // (如场景 state 与 target 指向同一节点),约束按 nodeId 映射回 spec 观测键;
    // 结果 id 翻译回场景 id,保证 trial.constraintResults 与 SceneContract 对齐。
    const sceneVars = [...scene.controls, ...scene.states, ...scene.disturbances, ...scene.observations, ...scene.guards]
    const specIdOf = new Map(sceneVars.map((v) => {
      const nodeId = v.nodeId ?? v.id
      return [v.id, this.aliases.get(nodeId) ?? nodeId]
    }))
    const originalIdOf = new Map(scene.constraints.map((c) => {
      const specId = specIdOf.get(c.id) ?? c.id
      return [specId, c.id]
    }))
    const mappedScene = {
      ...scene,
      constraints: scene.constraints.map(c => ({ ...c, id: specIdOf.get(c.id) ?? c.id })),
    }
    // 可观测性豁免:训练数据裁剪可能把约束引用的量测节点剔出模型 IO 面(如 feature 角色的
    // defect guard),模型轨迹里永远找不到该键 → 基类 fail-closed。这不是「违规」而是
    // 「无证据」:按可观测性豁免并显式标注,治理上由 recommendationOnly(不直接写 DCW)兜底。
    const observable = new Set<string>()
    for (const step of trajectory.steps) {
      for (const key of [...Object.keys(step.observations ?? {}), ...Object.keys(step.guards ?? {}), ...Object.keys(step.state ?? {})]) observable.add(key)
    }
    return this.base.evaluateConstraints(mappedScene as typeof scene, trajectory).map((r, i) => {
      const specId = mappedScene.constraints[i]?.id ?? r.id
      if (!r.passed && !observable.has(specId)) {
        return {
          ...r,
          id: originalIdOf.get(r.id) ?? r.id,
          passed: true,
          detail: `UNOBSERVABLE:约束 ${r.id} 的量测节点不在模型 IO 面(训练数据裁剪),模型无法评估;按可观测性豁免(recommendationOnly 兜底;建议场景版本升级时同步裁剪该约束)`,
        }
      }
      return { ...r, id: originalIdOf.get(r.id) ?? r.id }
    })
  }

  takeUncertainty(): ModelBackedUncertainty {
    return this.uncertainty
  }
}
