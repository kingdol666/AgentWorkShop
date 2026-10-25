/**
 * AML 预测服务:onnxruntime-node 懒加载(createRequire,optionalDependencies 缺失时
 * 结构化报错)+ session LRU 缓存(上限 4)+ one-step/闭环滚动推理(与 aml_eval.py 同口径)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { AppError } from '../../../utils/errors'
import { createLogger } from '../logger'
import { getAmlRuntime } from './runtime'
import type { AmlModelRow } from './aml.repo'
import { parseIoSpec } from './model-registry'
import { compileDeclarativeProvider } from './twin/declarative-provider'
import { parsePhysicsSpec, type PhysicsSpec } from './twin/physics-spec'
import { assertArxArtifactCurrent } from '../process-model/artifact-validation'

const log = createLogger('aml.predict')

/** onnxruntime InferenceSession.run 返回按输出名键控的对象(非数组) */
export interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>
  inputNames: string[]
  outputNames: string[]
}
export interface OrtModule {
  InferenceSession: {
    create(path: string, opts?: { providers?: string[] }): Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>, inputNames: string[], outputNames: string[] }>
  }
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown
}

const g = globalThis as typeof globalThis & {
  __amlOrt?: OrtModule | null
  __amlSessions?: Map<string, { session: OrtSession, at: number }>
}

function loadOrt(): OrtModule | null {
  if (g.__amlOrt !== undefined) return g.__amlOrt
  try {
    const require = createRequire(import.meta.url)
    g.__amlOrt = require('onnxruntime-node') as OrtModule
  }
  catch (err) {
    g.__amlOrt = null
    log.warn(`[aml-predict] onnxruntime-node 不可用:${err instanceof Error ? err.message : String(err)}`)
  }
  return g.__amlOrt ?? null
}

export function predictorAvailable(): boolean {
  return loadOrt() != null
}

/** 供孪生侧(model-backed provider)复用同一 ONNX 运行时与会话 LRU */
export function ortRuntime(): OrtModule | null {
  return loadOrt()
}

export async function onnxSessionFor(modelPath: string, modelId: string): Promise<OrtSession> {
  return sessionFor(modelPath, modelId)
}

async function sessionFor(modelPath: string, modelId: string): Promise<OrtSession> {
  if (!g.__amlSessions) g.__amlSessions = new Map()
  const cached = g.__amlSessions.get(modelId)
  if (cached) {
    cached.at = Date.now()
    return cached.session
  }
  const ort = loadOrt()
  if (!ort) {
    throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', '预测服务依赖 onnxruntime-node 未安装:执行 pnpm install(可选依赖)后重启')
  }
  const created = await ort.InferenceSession.create(modelPath, { providers: ['CPUExecutionProvider'] })
  // LRU 上限 4:超出驱逐最旧
  if (g.__amlSessions.size >= 4) {
    const oldest = [...g.__amlSessions.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) g.__amlSessions.delete(oldest[0])
  }
  g.__amlSessions.set(modelId, { session: created as unknown as OrtSession, at: Date.now() })
  return created as unknown as OrtSession
}

export interface IoSpec {
  version: number
  purpose: string
  modelInterface: string
  historySteps: number
  horizonSteps: number
  allNodes: string[]
  controlNodes: string[]
  targetNodes: string[]
  norm: { x: { mean: number[], std: number[] }, u: { mean: number[], std: number[] }, y: { mean: number[], std: number[] } }
  beatMs: number
  assumptions: string
}

interface HybridArtifactManifest { physicsSpec?: unknown, residualScale?: number, composition?: string, physicsSpecHash?: string }

function hybridManifestOf(modelPath: string): HybridArtifactManifest | null {
  const path = join(modelPath, 'hybrid_manifest.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HybridArtifactManifest
  }
  catch {
    throw new AppError(409, 'AML_HYBRID_MANIFEST_INVALID', 'Hybrid 模型 hybrid_manifest.json 无法解析')
  }
}

function hybridPhysicsNext(manifest: HybridArtifactManifest, io: IoSpec, historyNorm: number[][], controlsNorm: number[]): number[] {
  if (!manifest.physicsSpec) throw new AppError(409, 'AML_HYBRID_PHYSICS_MISSING', 'Hybrid 模型缺少冻结 PhysicsSpec，拒绝把 residual 当完整预测')
  const spec = parsePhysicsSpec(manifest.physicsSpec) as PhysicsSpec
  const provider = compileDeclarativeProvider(spec)
  const mx = io.norm.x.mean
  const sx = io.norm.x.std
  const mu = io.norm.u.mean
  const su = io.norm.u.std
  const last = historyNorm[historyNorm.length - 1] ?? []
  const rawHistory = last.map((value, index) => value * (sx[index] ?? 1) + (mx[index] ?? 0))
  const rawControls = controlsNorm.map((value, index) => value * (su[index] ?? 1) + (mu[index] ?? 0))
  const byNode = new Map(io.allNodes.map((node, index) => [node, rawHistory[index] ?? 0]))
  const specVar = (id: string) => spec.variables.find(variable => (variable.nodeId ?? variable.id) === id || variable.id === id)
  const stateEstimate: Record<string, number> = {}
  const controlValues: Record<string, number> = {}
  const disturbances: Record<string, number> = {}
  for (const variable of spec.variables) {
    const node = variable.nodeId ?? variable.id
    const value = byNode.get(node)
    if (value == null) continue
    if (variable.role === 'state') stateEstimate[variable.id] = value
    if (variable.role === 'disturbance') disturbances[variable.id] = value
  }
  io.controlNodes.forEach((node, index) => {
    const variable = specVar(node)
    if (variable) controlValues[variable.id] = rawControls[index] ?? 0
    controlValues[node] = rawControls[index] ?? 0
  })
  const step = provider.step({ state: provider.initialize({ stateEstimate, controlValues }), controls: controlValues, disturbances, dtSec: spec.solver.dtSec })
  const physicsRaw = io.targetNodes.map((node) => {
    const variable = specVar(node)
    const value = step.observations[node] ?? (variable ? step.observations[variable.id] : undefined)
    if (!Number.isFinite(value)) throw new AppError(409, 'AML_HYBRID_PHYSICS_OUTPUT_MISSING', `PhysicsSpec 未生成目标 ${node}`)
    return Number(value)
  })
  return physicsRaw.map((value, index) => (value - (io.norm.y.mean[index] ?? 0)) / (io.norm.y.std[index] ?? 1))
}

export interface PredictRequest {
  /** 历史:[historySteps][nAllNodes],顺序 = io_spec.allNodes;ONNX 为原始物理量,typed 工件为模型单位(调用方负责 scale/offset)。 */
  history: number[][]
  /** 未来控制轨迹:[≤horizonSteps][nControlNodes];单位同 history,typed 列顺序 = mvOrder;缺省 = 持最后观测。 */
  controls?: number[][]
  /** 滚动步数(≤horizonSteps;缺省 = horizonSteps) */
  steps?: number
}

export interface PredictResult {
  modelId: string
  stage: string
  targetNodes: string[]
  /** 预测:[steps][nTargetNodes];ONNX 为原始物理量,typed 工件为模型单位。 */
  forecast: number[][]
  beatMs: number
  assumptions: string
}

/** 单模型推理(内部):historyRaw [H][nAll] → 逐步滚动 steps 步 */
export async function predictWithModel(
  modelId: string,
  req: PredictRequest,
): Promise<PredictResult> {
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(modelId)
  if (!row) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${modelId} 不存在`)
  const artifactKind = resolveArtifactKind(row)
  if (existsSync(join(row.path, 'STUB'))) {
    throw new AppError(409, 'AML_STUB_MODEL', '该模型为存根作业产物(AML_STUB),不含真实权重,不可用于预测')
  }
  if (row.artifactsPruned) {
    throw new AppError(410, 'AML_ARTIFACT_MISSING', `模型 ${modelId} 工件已被 GC 清理(artifacts_pruned),请用同配方数据重训`)
  }
  // 新工件类型分派(linear_state_space/static_response):不要求 model.onnx
  if (artifactKind === 'linear_state_space@1' || artifactKind === 'static_response@1') {
    return predictWithTypedArtifact(row, artifactKind, req)
  }
  if (!existsSync(join(row.path, 'model.onnx'))) {
    throw new AppError(410, 'AML_ARTIFACT_MISSING', `模型 ${modelId} 工件已被 GC 清理(artifacts_pruned),请用同配方数据重训`)
  }
  const io = parseIoSpec(row) as unknown as IoSpec
  const hybrid = hybridManifestOf(row.path)
  if (io.modelInterface !== 'one_step') {
    throw new AppError(500, 'AML_IO_UNSUPPORTED', `未知模型接口 ${io.modelInterface}`)
  }
  const H = io.historySteps
  const nAll = io.allNodes.length
  const nCtrl = io.controlNodes.length
  const steps = Math.max(1, Math.min(req.steps ?? io.horizonSteps, io.horizonSteps))

  if (!Array.isArray(req.history) || req.history.length !== H || req.history.some(r => !Array.isArray(r) || r.length !== nAll)) {
    throw new AppError(422, 'AML_INPUT_SHAPE', `history 形状须为 [${H}][${nAll}](节点顺序 = allNodes):${io.allNodes.join(',')}`)
  }

  const sess = await sessionFor(join(row.path, 'model.onnx'), row.id)
  const mx = io.norm.x.mean
  const sx = io.norm.x.std
  const my = io.norm.y.mean
  const sy = io.norm.y.std

  // 归一化历史(norm 统计来自 train 切分,列数与 allNodes 对齐;越界兜底恒等变换)
  const hist: number[][] = req.history.map(r => r.map((v, j) => (v - (mx[j] ?? 0)) / (sx[j] ?? 1)))
  const lastHist = hist[hist.length - 1] ?? []
  // 控制轨迹(统一为归一化形态):显式提供 raw 值 → 用 u 统计归一化;
  // 缺省 = 历史最后观测的 control 值持稳(取 hist 中的归一化值,勿再归一化)
  const ctrlIndex = io.allNodes.map((n, j) => (io.controlNodes.includes(n) ? j : -1)).filter(j => j >= 0)
  const lastCtrlNorm = ctrlIndex.map(j => lastHist[j] ?? 0)
  const ctrlRows: number[][] = []
  for (let k = 0; k < steps; k++) {
    const provided = req.controls?.[k]
    if (provided && provided.length === nCtrl) {
      ctrlRows.push(provided.map((v, j) => (v - (io.norm.u.mean[j] ?? 0)) / (io.norm.u.std[j] ?? 1)))
    }
    else {
      ctrlRows.push([...lastCtrlNorm])
    }
  }

  const forecast: number[][] = []
  for (let k = 0; k < steps; k++) {
    const input = hist.slice(hist.length - H).map(r => Float32Array.from(r))
    if (hybrid) {
      const modelLast = input[H - 1]
      if (modelLast && ctrlIndex.length === (ctrlRows[k]?.length ?? 0)) {
        ctrlIndex.forEach((position, index) => {
          modelLast[position] = ctrlRows[k]?.[index] ?? modelLast[position] ?? 0
        })
      }
    }
    const flat = new Float32Array(H * nAll)
    for (let i = 0; i < H; i++) {
      input[i]?.forEach((v, j) => {
        flat[i * nAll + j] = v
      })
    }
    const ort = loadOrt()
    if (!ort) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', '预测服务依赖 onnxruntime-node 未安装:执行 pnpm install(可选依赖)后重启')
    const inpName = sess.inputNames[0]
    if (!inpName) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', `模型 ${row.id} 的 ONNX session 无有效输入名`)
    const outName = sess.outputNames[0] ?? inpName
    const out = await sess.run({ [inpName]: new ort.Tensor('float32', flat, [1, H, nAll]) })
    const residual = Array.from((out[outName] as { data: ArrayLike<number> }).data) as number[]
    const yNext = hybrid
      ? hybridPhysicsNext(hybrid, io, hist.slice(hist.length - H), ctrlRows[k] ?? lastCtrlNorm).map((value, index) => value + Math.max(-Math.abs(hybrid.residualScale ?? 0.25), Math.min(Math.abs(hybrid.residualScale ?? 0.25), residual[index] ?? 0)))
      : residual
    // 组装下一行
    const rowNext = new Array<number>(nAll).fill(0)
    // feature 持最后观测;persistence
    for (let j = 0; j < nAll; j++) rowNext[j] = lastHist[j] ?? 0
    ctrlIndex.forEach((j, c) => {
      rowNext[j] = ctrlRows[k]?.[c] ?? (lastCtrlNorm[c] ?? 0)
    })
    io.targetNodes.forEach((_, t) => {
      const tn = io.targetNodes[t]
      if (tn !== undefined) rowNext[io.allNodes.indexOf(tn)] = yNext[t] ?? 0
    })
    hist.push(rowNext)
    forecast.push(yNext.map((v, t) => v * (sy[t] ?? 1) + (my[t] ?? 0)))
  }

  return {
    modelId: row.id,
    stage: row.stage,
    targetNodes: io.targetNodes,
    forecast,
    beatMs: io.beatMs,
    assumptions: hybrid ? `${io.assumptions}; hybrid=${hybrid.composition ?? 'y_phys + bounded_residual'}; physicsSpecHash=${hybrid.physicsSpecHash ?? 'unknown'}` : io.assumptions,
  }
}

/** 便捷入口:找 production 模型(product/recipe/purpose)→ 预测 */
export async function predictProduction(
  productId: string,
  recipeId: string,
  purpose: string,
  req: PredictRequest,
): Promise<PredictResult> {
  const rt = getAmlRuntime()
  const m = rt.repo.model.productionOf(productId, recipeId, purpose)
  if (!m) {
    throw new AppError(404, 'AML_NO_PRODUCTION_MODEL', `配方 ${recipeId} 尚无 ${purpose} 生产模型:先训练并通过门禁,再经 HITL 晋升 production`)
  }
  return predictWithModel(m.id, req)
}

/** 注册时深检:按工件类型分派(新工件校验 model.json 维度;ONNX 走试推理) */
export async function verifyModelArtifact(modelId: string): Promise<{ ok: boolean, detail: string }> {
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(modelId)
  if (!row) return { ok: false, detail: '模型不存在' }
  const kind = resolveArtifactKind(row)
  if (kind === 'linear_state_space@1' || kind === 'static_response@1') {
    try {
      const artifact = JSON.parse(readFileSync(join(row.path, 'model.json'), 'utf8')) as Record<string, unknown>
      if (artifact.kind !== kind) return { ok: false, detail: `工件 kind=${String(artifact.kind)} 与注册类型 ${kind} 不一致` }
      assertArxArtifactCurrent(artifact, modelId)
      if (kind === 'linear_state_space@1') {
        const stateDim = Number(artifact.stateDim)
        const A = artifact.A as number[][]
        if (!Array.isArray(A) || A.length !== stateDim || A.some(r => r.length !== stateDim)) return { ok: false, detail: '状态矩阵维度不一致' }
      }
      else if (!artifact.coefficients || typeof artifact.coefficients !== 'object') {
        return { ok: false, detail: '响应面系数缺失' }
      }
      return { ok: true, detail: `${kind} 工件结构校验通过` }
    }
    catch (err) {
      return { ok: false, detail: `工件加载失败:${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (!predictorAvailable()) return { ok: false, detail: 'onnxruntime-node 不可用' }
  try {
    const io = parseIoSpec(row) as unknown as IoSpec
    const sess = await sessionFor(join(row.path, 'model.onnx'), row.id)
    const H = io.historySteps
    const nAll = io.allNodes.length
    const flat = new Float32Array(H * nAll)
    const ort = loadOrt()
    if (!ort) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', '预测服务依赖 onnxruntime-node 未安装:执行 pnpm install(可选依赖)后重启')
    const inpName = sess.inputNames[0]
    if (!inpName) throw new AppError(503, 'AML_PREDICTOR_UNAVAILABLE', `模型 ${row.id} 的 ONNX session 无有效输入名`)
    const outName = sess.outputNames[0] ?? inpName
    const out = await sess.run({ [inpName]: new ort.Tensor('float32', flat, [1, H, nAll]) })
    const y = (out[outName] as { data: ArrayLike<number> }).data
    const expect = io.targetNodes.length
    if (Array.from(y).length !== expect) {
      return { ok: false, detail: `输出维度 ${Array.from(y).length} ≠ target 数 ${expect}` }
    }
    return { ok: true, detail: '试推理通过' }
  }
  catch (err) {
    return { ok: false, detail: `加载/推理失败:${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 历史行 artifactKind 为空:由 hybrid_manifest 存在性/默认 ONNX 推断(不伪造新语义)。 */
export function resolveArtifactKind(row: AmlModelRow): string {
  if (row.artifactKind) return row.artifactKind
  return existsSync(join(row.path, 'hybrid_manifest.json')) ? 'hybrid_manifest@1' : 'onnx_one_step@1'
}

/**
 * 新工件预测(linear_state_space / static_response):
 * history[H][nAll]、controls 与 forecast 使用工件模型单位,此处不施加 scale/offset。
 * allNodes/返回 targetNodes 为实际节点 ID;矩阵与系数顺序保留 mvOrder/cvOrder 的逻辑变量 ID。
 */
async function predictWithTypedArtifact(row: AmlModelRow, kind: string, req: PredictRequest): Promise<PredictResult> {
  const io = parseIoSpec(row) as unknown as IoSpec & { mvOrder?: string[], cvOrder?: string[], featureOrder?: string[], variables?: Array<{ id: string, nodeId: string }> }
  const H = io.historySteps
  const nAll = io.allNodes.length
  if (!Array.isArray(req.history) || req.history.length !== H || req.history.some(r => !Array.isArray(r) || r.length !== nAll)) {
    throw new AppError(422, 'AML_INPUT_SHAPE', `history 形状须为 [${H}][${nAll}](节点顺序 = allNodes):${io.allNodes.join(',')}`)
  }
  const artifact = JSON.parse(readFileSync(join(row.path, 'model.json'), 'utf8')) as Record<string, unknown>
  assertArxArtifactCurrent(artifact, row.id)
  const mvOrder = (io.mvOrder ?? io.controlNodes) as string[]
  const cvOrder = (io.cvOrder ?? io.targetNodes) as string[]
  const resolveNodes = (order: string[]): string[] => order.map((id) => {
    const mappings = (io.variables ?? []).filter(variable => variable.id === id)
    if (mappings.length > 1) throw new AppError(500, 'AML_IO_UNSUPPORTED', `io_spec 的变量 ${id} 存在重复节点映射`)
    // 旧 typed 工件直接以节点 ID 记录顺序;新工件通过 variables 映射,不改写冻结的逻辑顺序。
    const nodeId = mappings.length ? mappings[0]?.nodeId : id
    if (!nodeId || io.allNodes.filter(node => node === nodeId).length !== 1) {
      throw new AppError(500, 'AML_IO_UNSUPPORTED', `io_spec 的变量 ${id} 缺少唯一的 allNodes 节点映射`)
    }
    return nodeId
  })
  const mvNodes = resolveNodes(mvOrder)
  const cvNodes = resolveNodes(cvOrder)
  if (new Set([...mvNodes, ...cvNodes]).size !== mvNodes.length + cvNodes.length) {
    throw new AppError(500, 'AML_IO_UNSUPPORTED', 'io_spec 的多个 MV/CV 变量映射到同一节点')
  }
  const mvIdx = mvNodes.map(id => io.allNodes.indexOf(id))
  const cvIdx = cvNodes.map(id => io.allNodes.indexOf(id))
  const steps = Math.max(1, Math.min(req.steps ?? io.horizonSteps, io.horizonSteps))
  const last = req.history[req.history.length - 1] ?? []

  if (kind === 'static_response@1') {
    const coefficients = artifact.coefficients as Record<string, number[]>
    const featureOrder = (artifact.featureOrder ?? io.featureOrder ?? []) as string[]
    const u = mvIdx.map((idx, m) => req.controls?.[0]?.[m] ?? last[idx] ?? 0)
    const y = cvOrder.map(cv => evaluateStaticFeature(coefficients[cv] ?? [], featureOrder, mvOrder, u))
    return {
      modelId: row.id, stage: row.stage, targetNodes: cvNodes, forecast: Array.from({ length: steps }, () => [...y]),
      beatMs: io.beatMs, assumptions: `${kind}: cv=f(MV) 稳态响应面;多步输出为同一稳态解`,
    }
  }

  const A = artifact.A as number[][]
  const B = artifact.B as number[][]
  const C = artifact.C as number[][]
  const D = artifact.D as number[][]
  const bias = (artifact.bias ?? []) as number[]
  const ar = Number(artifact.arOrder)
  const K = Number(artifact.K)
  const stateDim = Number(artifact.stateDim)
  const layout = artifact.layout as { yOffset: number, uOffset: number }
  const x = new Array<number>(stateDim).fill(0)
  for (let j = 0; j < cvOrder.length; j++) {
    for (let i = 0; i < ar; i++) x[layout.yOffset + j * ar + i] = req.history[H - 1 - i]?.[cvIdx[j]!] ?? 0
  }
  for (let m = 0; m < mvOrder.length; m++) {
    for (let q = 0; q < K; q++) x[layout.uOffset + m * K + q] = req.history[H - 1 - q]?.[mvIdx[m]!] ?? 0
  }
  const forecast: number[][] = []
  for (let k = 0; k < steps; k++) {
    const u = mvIdx.map((idx, m) => req.controls?.[k]?.[m] ?? last[idx] ?? 0)
    const next = new Array<number>(stateDim).fill(0)
    for (let r = 0; r < stateDim; r++) {
      let v = bias[r] ?? 0
      for (let c = 0; c < stateDim; c++) v += (A[r]?.[c] ?? 0) * (x[c] ?? 0)
      for (let m = 0; m < mvOrder.length; m++) v += (B[r]?.[m] ?? 0) * (u[m] ?? 0)
      next[r] = v
    }
    for (let c = 0; c < stateDim; c++) x[c] = next[c]!
    forecast.push(cvOrder.map((_id, j) => {
      let y = 0
      for (let c = 0; c < stateDim; c++) y += (C[j]?.[c] ?? 0) * (x[c] ?? 0)
      for (let m = 0; m < mvOrder.length; m++) y += (D[j]?.[m] ?? 0) * (u[m] ?? 0)
      return y
    }))
  }
  return {
    modelId: row.id, stage: row.stage, targetNodes: cvNodes, forecast,
    beatMs: io.beatMs, assumptions: `${kind}: y(k)=Cx(k),x(k+1)=Ax(k)+Bu(k)+bias`,
  }
}

function evaluateStaticFeature(coefficients: number[], featureOrder: string[], mvOrder: string[], u: number[]): number {
  const byName = new Map<string, number>()
  mvOrder.forEach((id, i) => byName.set(id, u[i] ?? 0))
  let sum = 0
  for (let k = 0; k < featureOrder.length; k++) {
    const name = featureOrder[k]!
    let value: number
    if (name === 'bias') value = 1
    else if (name.endsWith('^2')) value = (byName.get(name.slice(0, -2)) ?? 0) ** 2
    else if (name.includes('*')) {
      const [a, b] = name.split('*')
      value = (byName.get(a!) ?? 0) * (byName.get(b!) ?? 0)
    }
    else value = byName.get(name) ?? 0
    sum += (coefficients[k] ?? 0) * value
  }
  return sum
}

/** 供工具层:最近窗口组装(history 取自传入原始行,不做 DAQ 查询 —— 查询在工具层完成) */
export function readIoSpecFor(modelId: string): IoSpec {
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(modelId)
  if (!row) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${modelId} 不存在`)
  return parseIoSpec(row) as unknown as IoSpec
}

export function metricsOf(modelId: string): Record<string, unknown> {
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(modelId)
  if (!row) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${modelId} 不存在`)
  try {
    return JSON.parse(row.metricsJson)
  }
  catch { return {} }
}

export function artifactReadmeOf(modelPath: string): string | null {
  const p = join(modelPath, 'REGISTERED')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
