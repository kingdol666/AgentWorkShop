/**
 * ManagerChannelTemplates —— Channel 模板与一键实例化
 * (分层 14/19,承 ManagerTeams)
 */
import { ManagerTeams } from './12-teams'
import type { ActingUser, ChannelTemplateDetail } from './types'
import type { ChannelTemplateMember, ChannelTemplateRepo } from '../../db/channel-template.repo'
import type { ChannelTemplateRow } from '../../db/database'
import { AppError } from '../../../../utils/errors'
import { KNOWN_HARNESSES } from './helpers'
import { parseJson } from '../../db/database'

export abstract class ManagerChannelTemplates extends ManagerTeams {
  /** 可见性感知 Channel 模板列表:普通用户 = 本人 + public(含内置);admin = 全量 */
  listChannelTemplatesVisibleTo(user: ActingUser): ChannelTemplateDetail[] {
    const rows = user.role === 'admin'
      ? this.deps.repos.channelTemplates.list()
      : this.deps.repos.channelTemplates.listVisible(user.id)
    return rows.map(row => this.channelTemplateDetailOf(row))
  }

  /** Channel 模板详情;不存在返回 undefined */
  getChannelTemplate(templateId: string): ChannelTemplateDetail | undefined {
    const row = this.deps.repos.channelTemplates.findById(templateId)
    if (!row) return undefined
    return this.channelTemplateDetailOf(row)
  }

  /** 创建 Channel 模板 */
  createChannelTemplate(input: {
    name: string
    description?: string
    scenarioPrompt?: string
    workspace?: string
    lead?: { name: string, harness: string, config?: Record<string, unknown> } | null
    members?: ChannelTemplateMember[]
    visibility?: string
    ownerUserId: string
  }): ChannelTemplateDetail {
    this.assertHarness(input.lead?.harness)
    const row = this.deps.repos.channelTemplates.create({
      name: input.name,
      description: input.description,
      scenarioPrompt: input.scenarioPrompt,
      workspace: input.workspace,
      lead: input.lead ?? null,
      members: input.members ?? [],
      visibility: input.visibility,
      ownerUserId: input.ownerUserId,
    })
    return this.channelTemplateDetailOf(row)
  }

  /** 从既有 Channel 实例捕获模板:场景 + 工作目录 + lead(内联)+ 成员(有模板引用则引用,否则内联快照) */
  createChannelTemplateFromChannel(channelId: string, input: { name: string, description?: string, visibility?: string }, ownerUserId: string): ChannelTemplateDetail {
    const channel = this.requireChannelRow(channelId)
    const members = this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.id !== channel.leadAgentId)
      .map((m): ChannelTemplateMember => m.templateId
        ? { templateId: m.templateId, role: m.role === 'lead' ? 'lead' : 'worker' }
        : { inline: { name: m.name, harness: m.harness, config: parseJson<Record<string, unknown>>(m.configJson, {}) }, role: m.role === 'lead' ? 'lead' : 'worker' })
    const leadInst = channel.leadAgentId
      ? this.deps.repos.channelAgents.findById(channel.leadAgentId)
      : undefined
    const lead = leadInst
      ? {
          name: leadInst.name,
          harness: leadInst.harness,
          config: parseJson<Record<string, unknown>>(leadInst.configJson, {}),
        }
      : null
    const row = this.deps.repos.channelTemplates.create({
      name: input.name,
      description: input.description,
      scenarioPrompt: channel.scenarioPrompt,
      workspace: channel.workspace,
      lead,
      members,
      visibility: input.visibility,
      ownerUserId,
    })
    return this.channelTemplateDetailOf(row)
  }

  /** 更新 Channel 模板(属主/admin;内置拒绝) */
  updateChannelTemplate(templateId: string, patch: Parameters<ChannelTemplateRepo['update']>[1]): ChannelTemplateDetail {
    const updated = this.deps.repos.channelTemplates.update(templateId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    return this.channelTemplateDetailOf(updated)
  }

  /** 删除 Channel 模板(属主/admin;内置拒绝) */
  removeChannelTemplate(templateId: string): void {
    this.deps.repos.channelTemplates.remove(templateId)
  }

  /**
   * 实例化 Channel 模板 → 新 channel(属主 = 操作用户):
   * 场景/工作目录照搬;lead 内联创建;成员逐个克隆(引用模板时校验操作者可读)。
   * 返回 createChannel 同构结果 + 成员实例数。
   */
  async instantiateChannelTemplate(templateId: string, user: ActingUser, nameOverride?: string): Promise<{ channelId: string, workspace: string, agentCount: number, leadAgentId?: string }> {
    const tpl = this.deps.repos.channelTemplates.findById(templateId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Channel 模板不存在: ${templateId}`)
    this.requireTemplateReadable(tpl, user, 'Channel 模板')
    const lead = tpl.leadJson
      ? parseJson<{ name: string, harness: string, config?: Record<string, unknown> } | null>(tpl.leadJson, null)
      : null
    const created = await this.createChannel({
      name: (nameOverride && nameOverride.trim()) || tpl.name,
      description: tpl.description,
      scenarioPrompt: tpl.scenarioPrompt,
      workspace: tpl.workspace || undefined,
      leadAgent: lead ? { name: lead.name, harness: lead.harness, config: lead.config } : undefined,
      ownerUserId: user.id,
    })
    const members = parseJson<ChannelTemplateMember[]>(tpl.membersJson, [])
    let agentCount = lead ? 1 : 0
    for (const m of members) {
      if ('templateId' in m) {
        const tplRow = this.deps.repos.agents.findById(m.templateId)
        if (!tplRow) throw new AppError(404, 'NOT_FOUND', `成员 Agent 模板不存在: ${m.templateId}`)
        this.requireTemplateReadable(tplRow, user, '成员 Agent 模板')
        await this.addAgentToChannel({ channelId: created.channelId, agentId: m.templateId, role: m.role, by: 'template' })
      }
      else {
        this.assertHarness(m.inline.harness)
        const inlineTpl = await this.createAgent({ name: m.inline.name, harness: m.inline.harness, config: m.inline.config, ownerUserId: user.id })
        await this.addAgentToChannel({ channelId: created.channelId, agentId: inlineTpl.id, role: m.role, by: 'template' })
      }
      agentCount += 1
    }
    return { channelId: created.channelId, workspace: created.workspace, agentCount, leadAgentId: created.leadAgentId }
  }

  protected assertHarness(harness: string | undefined): void {
    if (harness && !KNOWN_HARNESSES.has(harness)) {
      throw new AppError(400, 'BAD_REQUEST', `未知 harness: ${harness}`)
    }
  }

  protected channelTemplateDetailOf(row: ChannelTemplateRow): ChannelTemplateDetail {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scenarioPrompt: row.scenarioPrompt,
      workspace: row.workspace,
      lead: row.leadJson ? parseJson<ChannelTemplateDetail['lead']>(row.leadJson, null) : null,
      members: parseJson<ChannelTemplateMember[]>(row.membersJson, []),
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== 任务作业面 =====
}
