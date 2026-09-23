/**
 * AgentMemory 的依赖类型与对外 DTO(原 server/services/workshop/runtime/memory.ts 顶部模块级类型声明)。纯类型。
 */
import type { EmbeddingProvider } from '../embedding-provider'

export interface AgentMemoryOptions {
  channelId: string
  agentId: string
  /** 记忆引子(静态注入)预算覆盖;默认 AW_MEMORY_PRIMER_TOKENS(300)。完整内容经 search_memory 工具按需抓取 */
  budgetTokens?: number
  /** 注入后 recall 混合检索 + record* 自动向量化;未注入纯 FTS */
  embedder?: EmbeddingProvider
}

export interface RecallOptions {
  /** 默认 true;supervise 每 tick 调用应传 false 防 access_count 通胀 */
  touch?: boolean
  /** 本次召回预算覆盖(默认 AW_MEMORY_BUDGET_TOKENS) */
  budgetTokens?: number
  /** 检索域:auto=私有+公共(默认) / private=仅私有 / shared=仅 Channel 公共 */
  scope?: MemoryScope
  /** 任务关联集(自身+父+兄弟 ≤20):命中行终分 +RELATED_TASK_BOOST(任务需求驱动的相关性) */
  relatedTaskIds?: string[]
}

export type MemoryScope = 'auto' | 'private' | 'shared'

/** 结构化记忆片段(工具按需抓取的返回体;content 已还原为未切分原文) */
export interface MemorySnippet {
  id: string
  kind: string
  title: string
  content: string
  importance: number
  createdAt: string
  /** 综合得分(0.5×相关性+0.3×时近性+0.2×重要性) */
  score: number
  source: 'private' | 'shared'
}
