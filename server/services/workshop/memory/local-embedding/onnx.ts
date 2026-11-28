/**
 * 本地 ONNX 向量推理（2026-11-28）。
 *
 * 契约（实测 Xenova BERT 导出）：inputs = input_ids / attention_mask / token_type_ids，
 * outputs = last_hidden_state [1, seq, dims]。
 * 池化：BGE 系用 CLS（官方 sentence-transformers 配置 pooling_mode=cls），MiniLM 用
 * attention 加权 mean；两者都做 L2 归一化（向量检索用余弦距离）。
 *
 * 并发生纪律：ONNX 会话按模型 id 缓存（创建 ~100ms 级），推理串行化到单条 promise 链 ——
 * recall 在回合内是热路径，多 Agent 并发时避免同一 session 上排队爆内存。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { installedModel, type LocalEmbeddingModelDef } from './registry'
import { WordPieceTokenizer } from './tokenizer'

export type LocalEmbedMode = 'query' | 'passage'

/** onnxruntime-node 的最小类型面（官方包不带 d.ts；与 aml/predictor 同策略：懒加载 + 本地类型） */
interface OrtTensor {
  data: Float32Array
  dims: readonly number[]
}
interface OrtSession {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
}
interface OrtModule {
  InferenceSession: { create(pathOrBuffer: string | Uint8Array, opts?: Record<string, unknown>): Promise<OrtSession> }
  Tensor: new (type: 'int64' | 'float32', data: BigInt64Array | Float32Array, dims: readonly number[]) => unknown
}
const requireFromHere = createRequire(import.meta.url)
let ortModule: OrtModule | null = null
function loadOrt(): OrtModule {
  // 可选重依赖：只有真正启用本地模型时才 require（纯 FTS / HTTP 端点部署不背原生依赖）
  ortModule ??= requireFromHere('onnxruntime-node') as OrtModule
  return ortModule
}

interface LoadedModel {
  def: LocalEmbeddingModelDef
  session: OrtSession
  tokenizer: WordPieceTokenizer
  ort: OrtModule
}

const loaded = new Map<string, Promise<LoadedModel>>()
let runChain: Promise<unknown> = Promise.resolve()

/** 批大小：单批过多会在长记忆正文上放大峰值内存；8 是 24MB 量化模型的稳妥值 */
function batchSize(): number {
  const raw = Number(process.env.AW_MEMORY_EMBED_BATCH ?? '8')
  return Number.isFinite(raw) ? Math.max(1, Math.min(32, Math.floor(raw))) : 8
}

async function loadModel(def: LocalEmbeddingModelDef): Promise<LoadedModel> {
  const info = installedModel(def.id)
  if (!info) throw new Error(`本地模型未安装或文件不完整: ${def.id}`)
  const ort = loadOrt()
  const [onnxBuf, vocabText] = await Promise.all([
    readFile(join(info.dir, 'model_quantized.onnx')),
    readFile(join(info.dir, 'vocab.txt'), 'utf8'),
  ])
  const session = await ort.InferenceSession.create(onnxBuf, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, Math.min(4, Number(process.env.AW_MEMORY_EMBED_THREADS ?? '2') || 2)),
  })
  const tokenizer = new WordPieceTokenizer(vocabText, { lowercase: def.lowercase, maxLength: def.maxLength })
  return { def, session, tokenizer, ort }
}

export function localModelSession(modelId: string): Promise<LoadedModel> {
  const def = installedModel(modelId)
  if (!def) return Promise.reject(new Error(`本地模型未安装: ${modelId}`))
  let p = loaded.get(modelId)
  if (!p) {
    p = loadModel(def.def)
    // 失败不缓存（下次重试），成功缓存
    p.catch(() => loaded.delete(modelId))
    loaded.set(modelId, p)
  }
  return p
}

/** 模型切换/删除后清缓存（会话持有文件句柄，Windows 上不释放会挡住删除） */
export function resetLocalEmbeddingCache(): void {
  loaded.clear()
}

function poolVector(
  data: Float32Array,
  dims: number,
  seq: number,
  attention: number[],
  pooling: 'cls' | 'mean',
): Float32Array {
  const out = new Float32Array(dims)
  if (pooling === 'cls') {
    for (let d = 0; d < dims; d++) out[d] = data[d] ?? 0
  }
  else {
    let total = 0
    for (let s = 0; s < seq; s++) {
      const w = attention[s] ?? 0
      if (!w) continue
      total += w
      const base = s * dims
      for (let d = 0; d < dims; d++) out[d]! += (data[base + d] ?? 0) * w
    }
    const div = total || 1
    for (let d = 0; d < dims; d++) out[d]! /= div
  }
  let norm = 0
  for (let d = 0; d < dims; d++) norm += out[d]! * out[d]!
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < dims; d++) out[d]! /= norm
  return out
}

async function embedBatch(model: LoadedModel, texts: string[], mode: LocalEmbedMode): Promise<Float32Array[]> {
  const prefix = mode === 'query' ? model.def.queryPrefix : model.def.passagePrefix
  const prepared = texts.map(t => (prefix ? prefix + t : t))
  const { ids, attention, length } = model.tokenizer.encodeBatch(prepared)
  const flat = ids.flat()
  const flatMask = attention.flat()
  const batch = texts.length
  const feeds: Record<string, unknown> = {
    input_ids: new model.ort.Tensor('int64', BigInt64Array.from(flat), [batch, length]),
    attention_mask: new model.ort.Tensor('int64', BigInt64Array.from(flatMask), [batch, length]),
    token_type_ids: new model.ort.Tensor('int64', new BigInt64Array(batch * length), [batch, length]),
  }
  const out = await model.session.run(feeds)
  const tensor = (out as Record<string, OrtTensor>).last_hidden_state
  if (!tensor) throw new Error('本地模型输出缺少 last_hidden_state')
  const dims = model.def.dims
  const vectors: Float32Array[] = []
  for (let b = 0; b < batch; b++) {
    const seq = length
    const slice = tensor.data.subarray(b * seq * dims, (b + 1) * seq * dims)
    vectors.push(poolVector(slice, dims, seq, attention[b]!.map(Number), model.def.pooling))
  }
  return vectors
}

/** 本地推理入口：query 加检索指令，passage 加文档前缀；批内串行、批间串行 */
export function embedWithLocalModel(modelId: string, texts: string[], mode: LocalEmbedMode): Promise<Float32Array[]> {
  const run = async (): Promise<Float32Array[]> => {
    if (texts.length === 0) return []
    const model = await localModelSession(modelId)
    const size = batchSize()
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += size) {
      out.push(...await embedBatch(model, texts.slice(i, i + size), mode))
    }
    return out
  }
  // 全局串行链：失败不毒化后续调用
  const chained = runChain.then(run, run)
  runChain = chained.catch(() => undefined)
  return chained
}
