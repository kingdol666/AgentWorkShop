/**
 * 事件聚类引擎 — Codex/OpenHands 风格 turn block 增量版。
 *
 * 与旧版差异:
 *  - 增量聚类:只处理新增帧,块对象身份稳定(Vue 按 key 复用组件,流式更新不整树重建)
 *  - 内容智能去重:落定全文(status.message/agent.message)与已累计 delta 相同或为前缀扩展时
 *    绝不重复渲染第二遍——修复"连续两次重复渲染"(omp 消息流 delta 与 message_end 全文重复)
 *  - 跨块落定折回:工具调用把流切段时,deltas 累计跨块跟踪,message_end 全文按内容比对折回
 *    最后一段流块;先前流片段标记 coveredBy 折叠为一行提示(OpenHands 风格)
 *  - 纯函数供密集行视图复用:classifyEvent / foldStreamDuplicates / buildStreamText
 *
 * 本文件是薄门面:实现按职责拆到 ./event-blocks/ 各模块,此处只做 re-export,
 * 外部导入路径(`.../workshop/useEventBlocks`)与导出名保持不变。
 *  - types       BlockKind / EventBlock
 *  - constants   TOOL_META / KIND_META
 *  - classify    classifyEvent / agentHueColor
 *  - attention   AttentionTier / envelopeTier / blockTier
 *  - text-utils  normText / isStreaming / buildStreamText / streamCursorVisible
 *  - clusterer   BlockClusterer
 *  - markdown    escapeHtml / mdLite
 *  - mentions    MentionMember / maskMentions / restoreMentions / mdLiteMentions
 *  - fold-stream foldStreamDuplicates
 */

export { type BlockKind, type EventBlock } from './event-blocks/types'
export { TOOL_META, KIND_META } from './event-blocks/constants'
export { classifyEvent, agentHueColor } from './event-blocks/classify'
export { type AttentionTier, envelopeTier, blockTier } from './event-blocks/attention'
export { normText, isStreaming, buildStreamText, streamCursorVisible } from './event-blocks/text-utils'
export { BlockClusterer } from './event-blocks/clusterer'
export { escapeHtml, mdLite } from './event-blocks/markdown'
export { type MentionMember, maskMentions, restoreMentions, mdLiteMentions } from './event-blocks/mentions'
export { foldStreamDuplicates } from './event-blocks/fold-stream'
