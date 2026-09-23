/**
 * ManagerTeams —— AgentTeam 编组与批量部署
 * (分层 13/19,承 ManagerLeadTeam)
 */
import { ManagerLeadTeam } from './11-lead-team'
import type { ActingUser, AgentTeamDetail } from './types'
import type { AgentInfo } from '../../agents/agent-interface'
import type { ChannelPluginToggle } from '../../db/channel-plugins.repo'
import type { TeamRow } from '../../db/database'
import { AppError } from '../../../../utils/errors'
import { getChannelPluginsRepo } from '../../db/channel-plugins.repo'

export abstract class ManagerTeams extends ManagerLeadTeam {
  /** 创建 AgentTeam */
  async createTeam(input: { name: string, description?: string, visibility?: string, ownerUserId?: string | null, plugins?: ChannelPluginToggle[] }): Promise<AgentTeamDetail> {
    const row = this.deps.repos.teams.create({ name: input.name, description: input.description, visibility: input.visibility, ownerUserId: input.ownerUserId ?? null })
    // 建队时的插件勾选:以 team id 为键落 channel_plugins(team 作用域偏好),
    // 部署 deployTeamToChannel 时传导到目标 channel(未配置 = 全启用,向后兼容)
    if (input.plugins?.length) getChannelPluginsRepo().setMany(row.id, input.plugins)
    return this.teamDetailOf(row)
  }

  /** 全部 AgentTeam */
  async listTeams(): Promise<AgentTeamDetail[]> {
    return this.deps.repos.teams.list().map(row => this.teamDetailOf(row))
  }

  /** 用户视角编组列表(本人 + 遗留公共) */
  async listTeamsForUser(userId: string): Promise<AgentTeamDetail[]> {
    return this.deps.repos.teams.listForOwner(userId).map(row => this.teamDetailOf(row))
  }

  /** 可见性感知列表:普通用户 = 本人(任意可见性)+ 全部 public(含内置);admin = 全量 */
  async listTeamsVisibleTo(user: ActingUser): Promise<AgentTeamDetail[]> {
    const rows = user.role === 'admin'
      ? this.deps.repos.teams.list()
      : this.deps.repos.teams.listVisible(user.id)
    return rows.map(row => this.teamDetailOf(row))
  }

  /** AgentTeam 详情(含成员模板快照);不存在返回 undefined */
  getTeam(teamId: string): AgentTeamDetail | undefined {
    const row = this.deps.repos.teams.findById(teamId)
    if (!row) return undefined
    return this.teamDetailOf(row)
  }

  /** 更新 AgentTeam(name/description/visibility) */
  async updateTeam(teamId: string, patch: { name?: string, description?: string, visibility?: string }): Promise<AgentTeamDetail> {
    const updated = this.deps.repos.teams.update(teamId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
    return this.teamDetailOf(updated)
  }

  /** 删除 AgentTeam(仅删编组关系,不动模板与其已部署实例) */
  async removeTeam(teamId: string): Promise<void> {
    this.deps.repos.teams.remove(teamId)
  }

  /** 把 Agent 模板加入 AgentTeam(同 team 内模板唯一;至多一个 lead) */
  async addTemplateToTeam(input: { teamId: string, templateId: string, role?: 'lead' | 'worker' }): Promise<AgentTeamDetail> {
    const team = this.deps.repos.teams.findById(input.teamId)
    if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${input.teamId}`)
    const tpl = this.deps.repos.agents.findById(input.templateId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${input.templateId}`)
    const role = input.role ?? 'worker'
    if (this.deps.repos.teamMembers.findByTeamTemplate(input.teamId, input.templateId)) {
      throw new AppError(409, 'ALREADY_MEMBER', `模板 ${input.templateId} 已在 team ${input.teamId} 中`)
    }
    if (role === 'lead' && this.deps.repos.teamMembers.countLead(input.teamId) > 0) {
      throw new AppError(409, 'LEAD_EXISTS', `team ${input.teamId} 已存在 lead`)
    }
    this.deps.repos.teamMembers.add({ teamId: input.teamId, templateId: input.templateId, role })
    return this.teamDetailOf(team)
  }

  /** 从 AgentTeam 移除 Agent 模板(仅删编组关系) */
  async removeTemplateFromTeam(teamId: string, templateId: string): Promise<AgentTeamDetail> {
    const team = this.deps.repos.teams.findById(teamId)
    if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${teamId}`)
    const member = this.deps.repos.teamMembers.findByTeamTemplate(teamId, templateId)
    if (!member) throw new AppError(404, 'NOT_FOUND', `模板 ${templateId} 不在 team ${teamId} 中`)
    this.deps.repos.teamMembers.remove(teamId, templateId)
    return this.teamDetailOf(team)
  }

  /**
   * 批量部署 AgentTeam → Channel:对每个成员模板调用 addAgentToChannel 克隆出独立实例。
   * - channel 已有 lead 且 team 成员含 lead → 该成员 409 LEAD_EXISTS,默认整体失败(事务性语义)。
   *   实际上为简化:逐个克隆,失败时抛错(已克隆实例保留,调用方可 remove 重试)。
   * - 返回每个成员的部署结果(实例 AgentInfo)。
   */
  async deployTeamToChannel(input: {
    channelId: string
    teamId: string
  }): Promise<{ channelId: string, teamId: string, agents: AgentInfo[] }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${input.channelId}`)
    const team = this.deps.repos.teams.findById(input.teamId)
    if (!team) throw new AppError(404, 'NOT_FOUND', `AgentTeam 不存在: ${input.teamId}`)
    const members = this.deps.repos.teamMembers.listByTeam(input.teamId)
    if (members.length === 0) {
      throw new AppError(400, 'TEAM_EMPTY', `team ${input.teamId} 无成员,先添加 Agent 模板`)
    }
    const agents: AgentInfo[] = []
    for (const m of members) {
      const inst = await this.addAgentToChannel({
        channelId: input.channelId,
        agentId: m.templateId,
        role: m.role === 'lead' ? 'lead' : 'worker',
      })
      agents.push(inst)
    }
    // 团队插件开关传导:建队/团队设置显式配置过的开关随部署落到目标 channel
    // (以 team id 为键的偏好 → 以 channel id 为键;工具注入与 dispatch 同源过滤)
    const teamPlugins = getChannelPluginsRepo().explicitFor(input.teamId)
    if (teamPlugins && teamPlugins.size) {
      getChannelPluginsRepo().setMany(input.channelId, [...teamPlugins].map(([name, enabled]) => ({ name, enabled })))
    }
    return { channelId: input.channelId, teamId: input.teamId, agents }
  }

  protected teamDetailOf(row: TeamRow): AgentTeamDetail {
    const members = this.deps.repos.teamMembers.listByTeam(row.id)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
      members: members.map((m) => {
        const tpl = this.deps.repos.agents.findById(m.templateId)
        return {
          templateId: m.templateId,
          name: tpl?.name ?? '(deleted)',
          harness: tpl?.harness ?? '',
          role: m.role === 'lead' ? 'lead' : 'worker',
          addedAt: m.createdAt,
        }
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== Channel 模板管理面(v10:场景 + 工作目录 + 成员组合;实例化一键建 channel) =====
}
