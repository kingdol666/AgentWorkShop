/**
 * AgentMemory 的依赖类型与对外 DTO(原 server/services/workshop/runtime/memory.ts 顶部模块级类型声明)。纯类型。
 */
import type { EmbeddingProvider } from '../embedding-provider'

export interface AgentMemoryOptions {
  channelId: string
  agentId: string
  /** 记忆引子(静态注入)引擎自主决定是否注入 prompt;预算覆盖默认 AW_MEMORY_PRIMER_TOKENS(300) */
  budgetTokens?: number
  /** 注入后 recall 混合检索 + record* 自动向量化;未注入纯 FTS */
  embedder?: EmbeddingProvider
}

export interface RecallOptions {
  /** 默认 true;supervise 调用应传 false 防 access_count 通胀 */
  touch?: boolean
  /** 本次召回预算覆盖(默认 AW_MEMORY_BUDGET_TOKENS) */
  budgetTokens?: number
  /** 检索域:auto=私有+公共(sessionId 命中加分) / private / shared / session=仅当前会话作用域行 */
  scope?: MemoryScope
  /** 当前会话 id:'auto' 档 session 行加分;'session' 档只检该会话作用域行 */
  sessionId?: string | null
  /** 任务关联集(自身+父+兄弟 ≤20):命中行终分 +RELATED_TASK_BOOST(任务需求驱动的相关性) */
  relatedTaskIds?: string[]
  /**
   * 作用域上下文(WP-A3):经验行 scopeKey 命中时加分(同产线 +0.2 / 同产品 +0.1)。
   * 缺省由 repo.channelScope(channelId) 自动解析 lineId(channels.line_id)。
   */
  scopeContext?: ScopeContext
}

/** 作用域上下文(产线/产品锚点;null/空串 = 该维度不参与加分) */
export interface ScopeContext {
  lineId?: string | null
  productId?: string | null
}

/**
 * 记忆作用域档位。
 *  - auto:私有 + 本 Channel 共享(默认;sessionId 给定时 session 行 +0.15 加分)
 *  - private:仅本人私有行
 *  - shared:仅本 Channel 的 __team__ 行
 *  - session:仅 sessionId 匹配的作用域行(本人在该会话中沉淀/收获的记忆)
 */
export type MemoryScope = 'auto' | 'private' | 'shared' | 'session'

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
  /** §7.4 来源定位:Channel / task / session / 可见性(缺省 = 旧调用方未提供) */
  channelId?: string
  taskId?: string | null
  sessionId?: string | null
  rootId?: string | null
  visibility?: 'channel-shared' | 'private' | 'cross-channel'
  /** RSI 经验元信息(WP-A3;非经验行缺省):极性 / 生命周期 / 作用域 */
  outcome?: string
  status?: string
  scopeKind?: string
  scopeKey?: string
}
