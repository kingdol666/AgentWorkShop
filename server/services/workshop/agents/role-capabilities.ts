/**
 * 角色能力矩阵（Project 层 V1）。
 *
 * 关键约束：DB `role` 仍是 lead|worker；`agent_kind` 才是 Project 层标识。
 * 能力判定只在这里集中，避免把 project_leader 塞进 70+ 处 role union。
 */
export type AgentRole = 'lead' | 'worker'
export type AgentKind = 'channel_agent' | 'project_leader'
export type ChannelKind = 'normal' | 'project_office'

export interface AgentCapabilities {
  /** 可做 Channel 内 lead 决策（调度/派发/团队管理） */
  channelLead: boolean
  /** 可做项目级提案/复核（只写 proposal，不直接改库） */
  projectLeader: boolean
  /** 工具面：Channel lead 专属工具 */
  seesChannelLeadTools: boolean
  /** 工具面：项目只读/成果读取 */
  seesProjectReadTools: boolean
  /** 工具面：项目提案/复核/申请审批 */
  seesProjectProposeTools: boolean
  /** 工具面：Channel lead 提交成果 */
  seesProjectSubmitTool: boolean
  /** 工业写：project leader 永远 none；channel agent 受治理 */
  industrialWrite: 'none' | 'governed'
  /** active 项目期间不参与 idle 卸载 */
  idleUnloadExempt: boolean
  /** 可作为 Channel SchedulerLoop 的持有者 */
  ownsChannelScheduler: boolean
}

export function capabilitiesFor(
  role: AgentRole,
  agentKind: AgentKind = 'channel_agent',
  channelKind: ChannelKind = 'normal',
): AgentCapabilities {
  const projectLeader = agentKind === 'project_leader' && channelKind === 'project_office'
  const channelLead = agentKind === 'channel_agent' && channelKind === 'normal' && role === 'lead'
  return {
    channelLead,
    projectLeader,
    seesChannelLeadTools: channelLead,
    seesProjectReadTools: projectLeader || channelLead || (channelKind === 'normal' && role === 'worker'),
    seesProjectProposeTools: projectLeader,
    seesProjectSubmitTool: channelLead,
    industrialWrite: projectLeader ? 'none' : 'governed',
    idleUnloadExempt: projectLeader,
    ownsChannelScheduler: channelLead,
  }
}

/** 项目办公室的唯一合法 leader：role=lead + agent_kind=project_leader。 */
export function isProjectLeaderIdentity(role: string, agentKind?: string | null): boolean {
  return role === 'lead' && agentKind === 'project_leader'
}
