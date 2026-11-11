/**
 * 频道工具用量聚合(计划 H12,2026-11-11)—— agent.block 的**下游业务消费者**。
 *
 * 此前 Block 管线的消费面只有「前端渲染 + channel_events 持久化/回放」;本模块提供
 * 第三个消费面:按 harness|tool|agent 聚合 start/ok/error/unknown,供运维/复盘/改进
 * 统计使用(REST: GET /api/workshop/channels/:id/tool-usage)。
 *
 * 诚实口径:
 *  - 坏载荷(non-Block)计入 invalid 暴露,不静默吞;
 *  - 无 start 配对的 end 计入 unknown 桶(不做跨帧 start/end 关联 —— 单消息单工具行
 *    不变式下,同一行的 start/end 由源保证成对;跨帧关联是未来增强,不冒充已实现)。
 */
import { isAgentToolBlock, type AgentToolBlock } from '@/shared/agent-blocks'

/** 聚合输入行(repo.listByTypes 返回形态的子集) */
export interface ToolUsageEvent {
  at: string
  agentId: string | null
  payload: unknown
}

export interface ToolUsageRow {
  /** 聚合键 `harness|tool|agentId`(agentId null 记 '' ) */
  key: string
  tool: string
  harness: string
  agentId: string | null
  starts: number
  ok: number
  error: number
  unknown: number
  lastAt: string | null
}

export interface ToolUsageSummary {
  total: number
  invalid: number
  tools: ToolUsageRow[]
}

/** 行 → 块(坏载荷 null;invalid 由调用方按返回 null 计数) */
function blockOf(payload: unknown): AgentToolBlock | null {
  if (!payload || typeof payload !== 'object') return null
  return isAgentToolBlock((payload as { block?: unknown }).block) ? (payload as { block: AgentToolBlock }).block : null
}

/** 聚合:按 harness|tool|agent 分账;starts 降序 → tool 升序;lastAt 取最大 */
export function aggregateToolUsage(events: ToolUsageEvent[]): ToolUsageSummary {
  const byKey = new Map<string, ToolUsageRow>()
  let total = 0
  let invalid = 0
  for (const e of events) {
    const b = blockOf(e.payload)
    if (!b) {
      invalid++
      continue
    }
    total++
    const key = `${b.harness}|${b.tool}|${e.agentId ?? ''}`
    let row = byKey.get(key)
    if (!row) {
      row = {
        key,
        tool: b.tool,
        harness: b.harness,
        agentId: e.agentId,
        starts: 0, ok: 0, error: 0, unknown: 0, lastAt: null,
      }
      byKey.set(key, row)
    }
    if (b.phase === 'start') row.starts++
    else if (b.status === 'ok') row.ok++
    else if (b.status === 'error') row.error++
    else row.unknown++
    if (row.lastAt === null || e.at > row.lastAt) row.lastAt = e.at
  }
  const tools = [...byKey.values()].sort((a, b) =>
    b.starts - a.starts
    || a.tool.localeCompare(b.tool)
    || a.key.localeCompare(b.key))
  return { total, invalid, tools }
}
