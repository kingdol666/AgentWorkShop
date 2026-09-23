/**
 * Manager 的模块级纯工具(行转换 / 运行时键 / 用户名缓存 等),无 this 依赖。
 * 原为 manager.ts 内的模块私有声明,拆分后导出供各分层复用。
 */
import type { A2AArtifact, A2AMessage, ChannelMail, Part } from '../../types/a2a'
import type { AgentInfo } from '../../agents/agent-interface'
import type { ChannelAgentRow, MessageRow, TaskRow } from '../../db/database'
import type { TaskState, WorkspaceTask } from '../../types/task'
import { createLogger } from '../../logger'
import { knownHarnesses } from '../../agents/registry'
import { parseJson } from '../../db/database'
import { randomUUID } from 'node:crypto'
import { userRepository } from '../../../../repositories/user.repository'

export const log = createLogger('workshop.manager')

/** 全部仓储(依赖注入) */
export function instanceToAgentInfo(m: ChannelAgentRow): AgentInfo {
  return {
    id: m.id,
    channelId: m.channelId,
    name: m.name,
    harness: m.harness,
    role: m.role as 'lead' | 'worker',
    config: parseJson<Record<string, unknown>>(m.configJson, {}),
    token: m.token,
    enabled: m.enabled,
    /** 来源 Agent 模板 id(手工成员为 null)。
     *  外部调用方需要它把「模板 → 已部署实例」对上 —— Agent↔节点绑定必须落到实例 id,
     *  而绑定接口只回一个实例 id;不暴露这个字段时调用方只能靠名字猜(实测踩过)。 */
    templateId: m.templateId ?? null,
  }
}

/** TaskRow → WorkspaceTask(artifacts/history 反序列化) */
export function rowToTask(row: TaskRow): WorkspaceTask {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId ?? undefined,
    assigneeId: row.assigneeId,
    creatorId: row.creatorId ?? '',
    title: row.title,
    description: row.description ?? undefined,
    state: row.state as TaskState,
    progress: row.progress,
    retryCount: row.retryCount,
    artifacts: parseJson<A2AArtifact[]>(row.artifactsJson, []),
    history: parseJson<A2AMessage[]>(row.historyJson, []),
    routeReason: row.routeReason || undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** MessageRow → ChannelMail(parts/metadata 反序列化;渠道邮件公开投影) */
export function rowToChannelMail(row: MessageRow): ChannelMail {
  return {
    messageId: row.id,
    taskId: row.taskId,
    fromAgentId: row.fromAgentId,
    toAgentId: row.toAgentId,
    role: row.role as 'ROLE_USER' | 'ROLE_AGENT',
    parts: parseJson<Part[]>(row.partsJson, []),
    metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
    state: row.state,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  }
}

/** 构造 A2AMessage(统一入口) */
export function buildMessage(
  channelId: string,
  role: 'ROLE_USER' | 'ROLE_AGENT',
  parts: Part[],
  metadata: Record<string, unknown>,
): A2AMessage {
  return { messageId: randomUUID(), contextId: channelId, role, parts, metadata }
}

/** 运行时实例复合键(channel, 实例) */
/** channel llm_json 解析(容错;空/坏 JSON 返回 null) */
export function parseChannelLlm(json: string | undefined): { provider?: string, model?: string, effort?: string } | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as { provider?: string, model?: string, effort?: string }
    if (!v || typeof v !== 'object') return null
    return v
  }
  catch {
    return null
  }
}

export function runtimeKey(channelId: string, agentId: string): string {
  return `${channelId}\u0000${agentId}`
}

/** factory 支持的 harness 集(registry 单一事实源;lead 建成员时校验) */
export const KNOWN_HARNESSES = new Set(knownHarnesses())

/** 全局用户名解析(带 60s 缓存;owner 归属呈现用,解析失败返回 null) */
export const ownerNameCache = new Map<string, { name: string | null, at: number }>()
export function resolveOwnerName(userId: string): string | null {
  const hit = ownerNameCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.name
  let name: string | null
  try {
    name = userRepository.findById(userId)?.name ?? null
  }
  catch {
    name = null
  }
  ownerNameCache.set(userId, { name, at: Date.now() })
  return name
}

/** 运行时资源监控:单个 ChannelRuntime 视图 */
