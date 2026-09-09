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
import { parseIoSpec } from './model-registry'

const log = createLogger('aml.predict')

/** onnxruntime InferenceSession.run 返回按输出名键控的对象(非数组) */
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>
  inputNames: string[]
  outputNames: string[]
}
interface OrtModule {
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

export interface PredictRequest {
  /** 历史(原始物理量):[historySteps][nAllNodes],顺序 = io_spec.allNodes */
  history: number[][]
  /** 未来控制轨迹(原始物理量):[≤horizonSteps][nControlNodes];缺省 = 持最后观测 */
  controls?: number[][]
  /** 滚动步数(≤horizonSteps;缺省 = horizonSteps) */
  steps?: number
}

export interface PredictResult {
  modelId: string
  stage: string
  targetNodes: string[]
  /** 原始物理量预测:[steps][nTargetNodes] */
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
  if (existsSync(join(row.path, 'STUB'))) {
    throw new AppError(409, 'AML_STUB_MODEL', '该模型为存根作业产物(AML_STUB),不含真实权重,不可用于预测')
  }
  if (row.artifactsPruned || !existsSync(join(row.path, 'model.onnx'))) {
    throw new AppError(410, 'AML_ARTIFACT_MISSING', `模型 ${modelId} 工件已被 GC 清理(artifacts_pruned),请用同配方数据重训`)
  }
  const io = parseIoSpec(row) as unknown as IoSpec
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
    const yNext = Array.from((out[outName] as { data: ArrayLike<number> }).data) as number[] // [nTgt] 归一化
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
    assumptions: io.assumptions,
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

/** 注册时深检:ONNX 可加载 + 试推理形状正确(异步,REST 注册/晋升前调用) */
export async function verifyModelArtifact(modelId: string): Promise<{ ok: boolean, detail: string }> {
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(modelId)
  if (!row) return { ok: false, detail: '模型不存在' }
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
