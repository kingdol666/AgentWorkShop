/**
 * 本地向量模型注册表（2026-11-28）。
 *
 * 为什么内置注册表而不是"任意 HF 模型 id"：
 *  - 本地推理需要**词表驱动的 WordPiece 分词**与固定 I/O 契约（input_ids/attention_mask/
 *    token_type_ids → last_hidden_state）；只有 BERT 系 + 自带 vocab.txt 的 ONNX 导出可用，
 *    sentencepiece/Unigram 系（e5、XLM-R 派生）的 vocab.txt 在 Xenova 仓库里是 15 字节占位桩，
 *    贸然下载只会得到一个装得上却算不出的模型。
 *  - 清单是"策展"而非"开放"：每个条目都实测过文件名、体积与池化方式。
 *
 * 纪律：模型文件只落本地磁盘（AW_HOME/models/embedding/<id>），不上传不进库；
 * 下载源固定为 HuggingFace 官方与其公开镜像，URL 一律 https（见 download.ts 的白名单）。
 */
import { join } from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { awHome } from '@/shared/config/home.mjs'

export type LocalPooling = 'cls' | 'mean'

export interface LocalEmbeddingFile {
  /** 落盘文件名 */
  name: string
  /** 仓库内相对路径 */
  path: string
  /** 期望字节数（用于 UI 展示与下载后体积校验;缺省则只校验非空） */
  bytes: number
}

export interface LocalEmbeddingModelDef {
  id: string
  name: string
  dims: number
  /** 语言标签（UI 展示） */
  langs: string
  pooling: LocalPooling
  maxLength: number
  lowercase: boolean
  /** 检索查询前缀（BGE 官方建议的中文指令;passage 不加） */
  queryPrefix: string
  /** 文档/记忆片段前缀（多数模型为空;E5 系需要 "passage: "） */
  passagePrefix: string
  license: string
  note: string
  repo: string
  files: LocalEmbeddingFile[]
}

export const LOCAL_EMBEDDING_MODELS: LocalEmbeddingModelDef[] = [
  {
    id: 'bge-small-zh-v1.5',
    name: 'BGE Small 中文 v1.5',
    dims: 512,
    langs: '中文 · 英文',
    pooling: 'cls',
    maxLength: 512,
    lowercase: false,
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    passagePrefix: '',
    license: 'MIT',
    note: '中文语义检索默认推荐：体积 24MB、中文分词准，查询侧自动加官方检索指令。',
    repo: 'Xenova/bge-small-zh-v1.5',
    files: [
      { name: 'model_quantized.onnx', path: 'onnx/model_quantized.onnx', bytes: 24_010_842 },
      { name: 'vocab.txt', path: 'vocab.txt', bytes: 109_540 },
      { name: 'config.json', path: 'config.json', bytes: 716 },
    ],
  },
  {
    id: 'all-MiniLM-L6-v2',
    name: 'MiniLM L6 v2',
    dims: 384,
    langs: '英文',
    pooling: 'mean',
    maxLength: 256,
    lowercase: true,
    queryPrefix: '',
    passagePrefix: '',
    license: 'Apache-2.0',
    note: '英文为主的轻量模型（23MB）：纯英文语料更省算力；中文语料请用 BGE Small 中文。',
    repo: 'Xenova/all-MiniLM-L6-v2',
    files: [
      { name: 'model_quantized.onnx', path: 'onnx/model_quantized.onnx', bytes: 22_972_370 },
      { name: 'vocab.txt', path: 'vocab.txt', bytes: 231_508 },
      { name: 'config.json', path: 'config.json', bytes: 650 },
    ],
  },
]

export function findLocalEmbeddingModel(id: string): LocalEmbeddingModelDef | null {
  return LOCAL_EMBEDDING_MODELS.find(m => m.id === id) ?? null
}

/** 模型根目录（AW_HOME/models/embedding） */
export function localEmbeddingRoot(): string {
  return join(String(awHome()), 'models', 'embedding')
}

export function localModelDir(id: string): string {
  return join(localEmbeddingRoot(), id)
}

export interface InstalledModelInfo {
  def: LocalEmbeddingModelDef
  dir: string
  bytes: number
  installedAt: string | null
}

/** 已安装判定：所有声明文件存在且非空（ONNX 会话创建失败由调用方再兜一次） */
export function installedModel(id: string): InstalledModelInfo | null {
  const def = findLocalEmbeddingModel(id)
  if (!def) return null
  const dir = localModelDir(id)
  let bytes = 0
  for (const f of def.files) {
    const p = join(dir, f.name)
    if (!existsSync(p)) return null
    const size = statSync(p).size
    // 明显截断（<95%）视为未装完：宁可提示重下，也不要让 ORT 在运行期抛格式错
    if (size === 0 || (f.bytes > 0 && size < Math.floor(f.bytes * 0.95))) return null
    bytes += size
  }
  let installedAt: string | null
  try {
    installedAt = String(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).installedAt ?? '') || null
  }
  catch { installedAt = null }
  return { def, dir, bytes, installedAt }
}

export function installedModels(): InstalledModelInfo[] {
  return LOCAL_EMBEDDING_MODELS.map(m => installedModel(m.id)).filter((x): x is InstalledModelInfo => x !== null)
}

export function totalModelBytes(def: LocalEmbeddingModelDef): number {
  return def.files.reduce((sum, f) => sum + (f.bytes || 0), 0)
}
