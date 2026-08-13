/**
 * A2A 语义对象适配层 — harness → 平台统一数据模型 的纯函数转换工具。
 * 供 claude/omp impl 与外部入口(SSE 序列化/消息构造)复用:
 *  - 纯文本 → Part[](A2A 消息内容片段)
 *  - 任意 JSON 值 → Part(data 变体)
 *  - 纯文本 → A2AMessage(消息载体;messageId 由 randomUUID 生成,contextId/role 由调用方指定)
 *  - 纯文本 → A2AArtifact(任务成果;artifactId 由调用方显式指定,便于任务关联)
 * 仅类型转换,无 IO、无状态、无 harness 依赖。
 * 权威契约见 docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md §4.3。
 */
import { randomUUID } from 'node:crypto'
import type { A2AArtifact, A2AMessage, Part } from '../../types/a2a'

/** 纯文本 → 单个 text Part(带媒体类型标注,便于下游区分内容形态) */
export function textToParts(text: string): Part[] {
  return [{ text, mediaType: 'text/plain' }]
}

/** 任意 JSON 值 → data Part(结构化载荷;调用方自定 mediaType 可选) */
export function jsonToPart(data: unknown): Part {
  return { data, mediaType: 'application/json' }
}

/** 纯文本 → A2A 消息(messageId 由 randomUUID 生成;contextId/role 由调用方指定) */
export function textToA2AMessage(
  text: string,
  options: { contextId: string, role: 'ROLE_USER' | 'ROLE_AGENT' },
): A2AMessage {
  return {
    messageId: randomUUID(),
    contextId: options.contextId,
    role: options.role,
    parts: textToParts(text),
  }
}

/** 纯文本 → A2A 成果(artifactId 显式传入,便于与任务/分块关联) */
export function artifactFromText(text: string, artifactId: string): A2AArtifact {
  return { artifactId, parts: textToParts(text) }
}
