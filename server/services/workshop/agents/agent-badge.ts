/**
 * AgentBadge —— agentId → 「Channel名/成员名」人话徽标解析。
 *
 * 运维日志 actorName 用:Agent 的数控下发/判定/回退入册时,操作者不再落
 * agentId(UUID),而是「ChannelName/WorkerName」,与用户(用户名)和系统
 * (system)在 /logs 来源列天然区分。
 * 解析器由 plugins/workshop.ts 装配时注入(同 configureHitlResolver 模式,
 * 避免 agents/* 反向依赖 runtime/manager);未装配(单测/极早期)退回 agentId。
 */
export interface AgentBadge {
  /** 成员名(worker 名) */
  name: string
  /** 所属 Channel 名 */
  channelName: string
}

type BadgeResolver = (agentId: string) => AgentBadge | null

const g = globalThis as typeof globalThis & { __awBadgeResolver?: BadgeResolver }

export function configureAgentBadgeResolver(fn: BadgeResolver): void {
  g.__awBadgeResolver = fn
}

export function agentBadge(agentId: string): AgentBadge | null {
  try {
    return g.__awBadgeResolver?.(agentId) ?? null
  }
  catch {
    return null
  }
}

/** 徽标串:「Channel名/成员名」;解析失败退回 agentId(可追溯,不谎报) */
export function agentBadgeLabel(agentId: string): string {
  const b = agentBadge(agentId)
  return b ? `${b.channelName}/${b.name}` : agentId
}
