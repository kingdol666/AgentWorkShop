/**
 * server/services/workshop/runtime/memory.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts       依赖类型与 DTO
 *   helpers.ts     模块级纯工具/常量
 *   contracts.ts   跨层能力契约(3 个抽象方法)
 *   state.ts       构造与向量索引 / 作用域判定
 *   recall.ts      检索:命中收集 / 重排 / recall 与 recallRows
 *   write.ts       写入:save / 任务结果 / peer 交换 / 向量化
 *   governance.ts  上下文治理与团队历史(P0-3 幂等 upsert)
 *   score.ts       打分与行格式化
 *   facade.ts      最终类 + 模块级尾码
 */
export { AgentMemory } from './facade'
export type { AgentMemoryOptions } from './types'
export type { RecallOptions } from './types'
export type { MemoryScope } from './types'
export type { MemorySnippet } from './types'
export { envNum } from './helpers'
export { segmentCJK } from './helpers'
export { buildMatchQuery } from './helpers'
export { estimateTokens } from './helpers'
export { unsegmentCJK } from './helpers'
export { runMemoryMaintenance } from './helpers'
export { vectorizeMemory } from './helpers'
export type { MaintenanceResult } from './helpers'
