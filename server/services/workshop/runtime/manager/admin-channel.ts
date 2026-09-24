/**
 * ManagerAdminChannel —— Channel / Agent 模板管理面
 * (拆分层,承 ManagerNotifications)
 */
import { ManagerNotifications } from './notifications'
import type { ActingUser, AgentTemplateDetail } from './types'
import type { AgentInfo } from '../../agents/agent-interface'
import type { AgentRow, ChannelRow, WorkspaceRow } from '../../db/database'
import { AppError } from '../../../../utils/errors'
import { assertHarnessUsable } from '../../agents/harness-availability'
import { mkdirSync } from 'node:fs'
import { parseJson } from '../../db/database'
import { resolve } from 'node:path'
import { runtimeKey } from './helpers'

export abstract class ManagerAdminChannel extends ManagerNotifications {
  listWorkspaces(userId: string): Array<WorkspaceRow & { channelIds: string[] }> {
    // 纯读:挂载引用的失效清理已下沉到 removeChannel 的级联
    // (unmountChannelEverywhere)。早先这里在 .filter() 回调里 DELETE 挂载行,
    // 使 GET /api/workshop/workspaces 与 GET /users/me 成为**有副作用的读** ——
    // 读路径必须可重放、可缓存、可并发,不写库。
    return this.deps.repos.users.listWorkspaces(userId).map(ws => ({
      ...ws,
      channelIds: this.deps.repos.users.listMountedChannels(ws.id),
    }))
  }

  createWorkspace(userId: string, name: string): WorkspaceRow & { channelIds: string[] } {
    const trimmed = name.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', 'Workspace 名称不能为空')
    const ws = this.deps.repos.users.createWorkspace(userId, trimmed)
    return { ...ws, channelIds: [] }
  }

  deleteWorkspace(userId: string, workspaceId: string): void {
    const ws = this.deps.repos.users.getWorkspace(workspaceId)
    if (!ws) throw new AppError(404, 'NOT_FOUND', `workspace 不存在: ${workspaceId}`)
    this.requireOwned(ws.ownerUserId, userId, 'workspace')
    this.deps.repos.users.deleteWorkspace(workspaceId)
  }

  /** 挂载 channel(须为本人的 channel;遗留公共不可挂载) */
  mountChannelToWorkspace(userId: string, workspaceId: string, channelId: string): void {
    const ws = this.deps.repos.users.getWorkspace(workspaceId)
    if (!ws) throw new AppError(404, 'NOT_FOUND', `workspace 不存在: ${workspaceId}`)
    this.requireOwned(ws.ownerUserId, userId, 'workspace')
    const channel = this.requireChannelRow(channelId)
    this.requireOwned(channel.ownerUserId, userId, 'channel')
    this.deps.repos.users.mountChannel(workspaceId, channelId)
  }

  unmountChannelFromWorkspace(userId: string, workspaceId: string, channelId: string): void {
    const ws = this.deps.repos.users.getWorkspace(workspaceId)
    if (!ws) throw new AppError(404, 'NOT_FOUND', `workspace 不存在: ${workspaceId}`)
    this.requireOwned(ws.ownerUserId, userId, 'workspace')
    this.deps.repos.users.unmountChannel(workspaceId, channelId)
  }

  // ===== Channel 管理面 =====

  async createChannel(input: {
    name: string
    description?: string
    scenarioPrompt?: string
    workspace?: string
    leadAgent?: { name: string, harness: string, config?: Record<string, unknown> }
    ownerUserId?: string | null
  }): Promise<{ channelId: string, leadAgentId?: string, workspace: string }> {
    const channel = this.deps.repos.channels.create({ name: input.name, description: input.description, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
    // v17:owner 成员记录必须与 Channel 同时落库(不变量:有且只有一条 active owner)。
    // 迁移回填只覆盖**已存在**的 Channel;新建路径若不写,owner 会长期缺席名册 ——
    // 成员列表漏掉 owner、群成员数偏小,只能靠 requireChannelMember 的自愈副作用补,
    // 属于"读路径写库"的反模式(且未读群聊前一直不正确)。这里在创建点一次性收敛。
    if (channel.ownerUserId) {
      this.channelMemberRepo.ensureOwner(channel.id, channel.ownerUserId)
    }
    const workspace = input.workspace && input.workspace.length > 0
      ? input.workspace
      : resolve(process.cwd(), 'data', 'workspaces', channel.id)
    this.deps.repos.channels.update(channel.id, { workspace })
    this.ensureWorkspaceDir(workspace)

    let leadAgentId: string | undefined
    if (input.leadAgent) {
      // lead 内联模板归属 channel 属主(private;避免落成无主内置模板)
      const tpl = this.deps.repos.agents.create({
        name: input.leadAgent.name,
        harness: input.leadAgent.harness,
        config: input.leadAgent.config,
        ownerUserId: input.ownerUserId ?? null,
      })
      const inst = this.deps.repos.channelAgents.create({
        channelId: channel.id,
        templateId: tpl.id,
        name: tpl.name,
        harness: tpl.harness,
        config: parseJson<Record<string, unknown>>(tpl.configJson, {}),
        role: 'lead',
      })
      this.deps.repos.channels.update(channel.id, { leadAgentId: inst.id })
      leadAgentId = inst.id
      // 懒加载:仅持久化,不装配运行时;首次任务提交时 ensureChannelActive 触发装配
    }
    return { channelId: channel.id, leadAgentId, workspace }
  }

  async getChannel(channelId: string): Promise<ChannelRow & { agents: AgentInfo[] }> {
    const channel = this.requireChannelRow(channelId)
    const agents = await this.listChannelAgents(channelId)
    return { ...channel, agents }
  }

  async updateChannel(channelId: string, patch: { name?: string, description?: string, scenarioPrompt?: string, workspace?: string, enabled?: number, llm?: { provider?: string, model?: string, effort?: string } | null }): Promise<ChannelRow> {
    const channel = this.requireChannelRow(channelId)
    if (patch.workspace !== undefined && patch.workspace !== channel.workspace) {
      this.ensureWorkspaceDir(patch.workspace)
      await this.unloadChannelAgents(channelId)
    }
    if (patch.enabled === 0 && channel.enabled !== 0) {
      await this.unloadChannelAgents(channelId)
    }
    // 场景 prompt 变更 → 回收成员运行时(下次装配注入新场景;进度任务不受影响,
    // 排队任务在成员重新装配后按需恢复)
    if (patch.scenarioPrompt !== undefined && patch.scenarioPrompt !== channel.scenarioPrompt) {
      await this.unloadChannelAgents(channelId)
    }
    // channel 默认 LLM 变更 → 同样回收成员运行时(下次装配注入新默认;成员 config
    // 显式指定的 model/provider 优先,不受影响)
    const prevLlm = channel.llmJson
    const nextLlm = patch.llm !== undefined ? JSON.stringify(patch.llm) : undefined
    if (nextLlm !== undefined && nextLlm !== prevLlm) {
      await this.unloadChannelAgents(channelId)
    }
    const updated = this.deps.repos.channels.update(channelId, patch)
    // 卸载后 channel 需重新激活(懒装配 lead + 恢复调度驱动)
    if (updated && updated.leadAgentId && (patch.scenarioPrompt !== undefined || patch.workspace !== undefined || (nextLlm !== undefined && nextLlm !== prevLlm))) {
      this.ensureChannelActive(channelId)
    }
    return updated!
  }

  protected async unloadChannelAgents(channelId: string): Promise<void> {
    const cr = this.channels.get(channelId)
    if (cr) {
      const scheduler = cr.scheduler
      if (scheduler) await scheduler.stopAndWait()
      cr.scheduler = null
      const agents = [...cr.getAgents()]
      for (const agent of agents) {
        await agent.stop()
        cr.detachAgent(agent.agentId)
        this.agentIndex.delete(runtimeKey(channelId, agent.agentId))
      }
      if (cr.getAgents().length === 0) {
        this.channels.delete(channelId)
        this.buses.delete(channelId)
      }
    }
  }

  async updateChannelWorkspace(channelId: string, workspace: string): Promise<ChannelRow> {
    return this.updateChannel(channelId, { workspace })
  }

  protected ensureWorkspaceDir(workspace: string): void {
    mkdirSync(workspace, { recursive: true })
  }

  protected channelWorkspace(channelId: string): string {
    return this.deps.repos.channels.findById(channelId)?.workspace ?? ''
  }

  async listChannels(): Promise<ChannelRow[]> {
    return this.deps.repos.channels.list()
  }

  async removeChannel(channelId: string): Promise<void> {
    const cr = this.channels.get(channelId)
    if (cr) {
      const scheduler = cr.scheduler
      if (scheduler) await scheduler.stopAndWait()
      cr.scheduler = null
      for (const agent of [...cr.getAgents()]) {
        await agent.stop()
        this.agentIndex.delete(runtimeKey(channelId, agent.agentId))
      }
      this.channels.delete(channelId)
      this.buses.delete(channelId)
    }
    // 记忆级联清理:成员私有行 + team 公共行(防残留行污染他 channel 的 FTS/team 检索域)
    this.deps.repos.memories.deleteByChannel(channelId)
    // 定时任务级联清理(FK CASCADE 兜底;显式删除保证旧库无 FK 时也收敛)
    this.deps.repos.schedules?.removeByChannel(channelId)
    // workspace 挂载级联:不清理会留下"幽灵频道"(左栏有条目、右栏永空)——
    // 这是 listWorkspaces 读路径兜底要解决的问题,现在在删除侧一次性收敛
    // (与上一行 schedules 同口径:`repos` 允许旧脚手架只注入部分仓储,缺省即跳过级联)
    this.deps.repos.users?.unmountChannelEverywhere(channelId)
    this.deps.repos.channels.remove(channelId)
  }

  // ===== Agent 模板管理面(全局,可复用;v10 可见性隔离) =====

  /** 创建 Agent 模板(可复用数据结构;visibility 缺省 private) */
  async createAgent(input: {
    name: string
    harness: string
    config?: Record<string, unknown>
    visibility?: string
    ownerUserId?: string | null
  }): Promise<AgentTemplateDetail> {
    // 执行前强校验:引擎未安装的模板不允许落库(前端下拉已禁用未安装项,此处兜底)
    assertHarnessUsable(input.harness, input.config)
    const row = this.deps.repos.agents.create({ name: input.name, harness: input.harness, config: input.config, visibility: input.visibility, ownerUserId: input.ownerUserId ?? null })
    return this.templateDetailOf(row)
  }

  /** 列出全部 Agent 模板(全局) */
  async listAgents(): Promise<AgentTemplateDetail[]> {
    return this.deps.repos.agents.list().map(row => this.templateDetailOf(row))
  }

  /** 用户视角模板列表(本人 + 遗留公共) */
  async listAgentsForUser(userId: string): Promise<AgentTemplateDetail[]> {
    return this.deps.repos.agents.listForOwner(userId).map(row => this.templateDetailOf(row))
  }

  /** 可见性感知列表:普通用户 = 本人(任意可见性)+ 全部 public(含内置);admin = 全量 */
  async listAgentsVisibleTo(user: ActingUser): Promise<AgentTemplateDetail[]> {
    const rows = user.role === 'admin'
      ? this.deps.repos.agents.list()
      : this.deps.repos.agents.listVisible(user.id)
    return rows.map(row => this.templateDetailOf(row))
  }

  /** Agent 模板详情(含其克隆出的全部实例) */
  getAgent(agentId: string): AgentTemplateDetail | undefined {
    const row = this.deps.repos.agents.findById(agentId)
    if (!row) return undefined
    return this.templateDetailOf(row)
  }

  /** 更新 Agent 模板(name/harness/config/enabled/visibility);不影响已克隆实例(复制语义) */
  async updateAgent(agentId: string, patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number, visibility?: string }): Promise<AgentTemplateDetail> {
    const row = this.deps.repos.agents.findById(agentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${agentId}`)
    if (patch.harness) assertHarnessUsable(patch.harness, patch.config ?? parseJson<Record<string, unknown>>(row.configJson, {}))
    const updated = this.deps.repos.agents.update(agentId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${agentId}`)
    return this.templateDetailOf(updated)
  }

  /** 删除 Agent 模板(实例保留,template_id 置空) */
  async removeAgent(agentId: string): Promise<void> {
    if (!this.deps.repos.agents.findById(agentId)) return
    this.deps.repos.agents.remove(agentId)
  }

  protected templateDetailOf(row: AgentRow): AgentTemplateDetail {
    const instances = this.deps.repos.channelAgents.listByTemplate(row.id)
    return {
      id: row.id,
      name: row.name,
      harness: row.harness,
      config: parseJson<Record<string, unknown>>(row.configJson, {}),
      enabled: row.enabled,
      visibility: row.ownerUserId === null ? 'public' : row.visibility,
      isBuiltin: row.ownerUserId === null,
      ownerUserId: row.ownerUserId ?? null,
      instances: instances.map(i => ({ id: i.id, channelId: i.channelId, role: i.role as 'lead' | 'worker', token: i.token })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ===== Channel 实例管理面 =====
}
