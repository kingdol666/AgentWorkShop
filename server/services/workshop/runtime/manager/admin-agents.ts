/**
 * ManagerAdminAgents —— Channel 实例管理、记忆与成员增改删
 * (拆分层,承 ManagerAdminChannel)
 */
import { ManagerAdminChannel } from './admin-channel'
import type { AgentInfo } from '../../agents/agent-interface'
import type { MaintenanceResult, MemorySnippet } from '../memory'
import type { MemoryRow } from '../../db/database'
import { AgentMemory, runMemoryMaintenance, segmentCJK, unsegmentCJK, vectorizeMemory } from '../memory'
import { AppError } from '../../../../utils/errors'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import { assertHarnessUsable } from '../../agents/harness-availability'
import { assertSpawnConfigAllowed, assertSpawnConfigPatchAllowed, type SpawnActor } from '../../agents/harness-spawn-policy'
import { instanceToAgentInfo } from './helpers'
import { createChannelSession, closeChannelSession } from '../../agents/session-clone'
import { createTaskInstanceChannel } from '../../agents/task-channel'
import type { TaskInstanceDeps } from '../../agents/task-channel'
import { getAgentNodeBindingRepo } from '../../agents/node-bindings.repo'
import { createChannelSessionRepo, type ChannelSessionRow } from '../../db/channel-session.repo'
import type { SessionCloneDeps } from '../../agents/session-clone'
import { parseJson } from '../../db/database'
import { createImprovementActionRepo } from '../../db/improvement-action.repo'
import { randomUUID } from 'node:crypto'

export abstract class ManagerAdminAgents extends ManagerAdminChannel {
  /** 把 Agent 模板放入 channel → 克隆出独立身份 id 的新实例(复制 name/harness/config) */
  async addAgentToChannel(input: {
    channelId: string
    agentId: string
    role: 'lead' | 'worker'
    /** 模板 config 覆盖项(浅合并;用于注入/覆盖 systemPromptPrefix 等场景配置) */
    configOverride?: Record<string, unknown>
    /** 操作发起方(AEP agent.member 的 by;缺省 'user') */
    by?: string
    reason?: string
    /** 操作者（spawn 授权；缺省按普通用户处理） */
    actor?: SpawnActor
  }): Promise<AgentInfo> {
    const tpl = this.deps.repos.agents.findById(input.agentId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${input.agentId}`)
    const instConfig = { ...parseJson<Record<string, unknown>>(tpl.configJson, {}), ...input.configOverride }
    // 服务层收权：不能只在 REST 入口校验，lead/MCP/模板/调度路径也必须过同一门。
    assertSpawnConfigAllowed(tpl.harness, instConfig, input.actor ?? { role: 'user' })
    // 绑定即执行入口:引擎未安装的模板不许入 channel(deploy/加成员在此失败,不产生半成品实例)
    assertHarnessUsable(tpl.harness, instConfig)
    if (input.role === 'lead') {
      const channel = this.deps.repos.channels.findById(input.channelId)
      if (channel && channel.leadAgentId) {
        throw new AppError(409, 'LEAD_EXISTS', `channel ${input.channelId} 已存在 lead`)
      }
    }
    const inst = this.deps.repos.channelAgents.create({
      channelId: input.channelId,
      templateId: tpl.id,
      name: tpl.name,
      harness: tpl.harness,
      config: instConfig,
      role: input.role,
    })
    if (input.role === 'lead') {
      this.deps.repos.channels.update(input.channelId, { leadAgentId: inst.id })
    }
    this.notifyMember(input.channelId, {
      op: 'added',
      agentId: inst.id,
      name: inst.name,
      role: inst.role as 'lead' | 'worker',
      harness: inst.harness,
      enabled: inst.enabled,
      config: parseJson<Record<string, unknown>>(inst.configJson, {}),
      by: input.by ?? 'user',
      reason: input.reason,
    })
    return instanceToAgentInfo(inst)
  }

  async listChannelAgents(channelId: string): Promise<AgentInfo[]> {
    return this.deps.repos.channelAgents.listByChannel(channelId).map(instanceToAgentInfo)
  }

  /** Agent 记忆列表(私有观察面;content 还原为未切分原文,客户端可读):实例须存在于本 channel */
  listMemories(channelId: string, agentId: string, limit = 50): MemoryRow[] {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${agentId}`)
    return this.deps.repos.memories.listByAgent(agentId, limit)
      .map(r => ({ ...r, content: unsegmentCJK(r.content) }))
  }

  /**
   * 记忆混合检索(REST/客户端观察面;与 agent 运行时 search_memory 工具同源算法):
   * 以 targetAgent 视角召回(私有域 + 本 channel 公共域),scope 过滤同 recallRows。
   * caller 须为本 channel 成员;返回结构化片段(综合分排序,content 未切分原文)。
   */
  async searchAgentMemories(
    channelId: string,
    callerAgentId: string,
    targetAgentId: string,
    input: { query: string, scope?: 'auto' | 'private' | 'shared' | 'session', limit?: number, sessionId?: string | null },
    opts: { byOwner?: boolean } = {},
  ): Promise<MemorySnippet[]> {
    // byOwner:人类 owner(channel 属主)经控制台检索,跳过 agent 成员校验
    if (!opts.byOwner) this.requireMember(channelId, callerAgentId)
    if (!this.deps.repos.channelAgents.findByChannelAgent(channelId, targetAgentId)) {
      throw new AppError(404, 'NOT_FOUND', `Agent 实例不存在: ${targetAgentId}`)
    }
    const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: targetAgentId, embedder: this.memoryEmbedder ?? undefined })
    return mem.recallRows(input.query, { scope: input.scope, limit: input.limit, sessionId: input.sessionId })
  }

  // ===== 团队共享记忆域(agent_id='__team__' 哨兵;lead 策展,channel 内全员 recall 可见)=====

  /** 团队共享记忆列表(channel 级;任意本 channel 成员可读;content 还原为未切分原文) */
  listTeamMemories(channelId: string, limit = 50): MemoryRow[] {
    this.requireChannelRow(channelId)
    return this.deps.repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, limit)
      .map(r => ({ ...r, content: unsegmentCJK(r.content) }))
  }

  /** 写/更新团队记忆(仅 lead;稳定 dedupKey 幂等刷新;成功后 fire-and-forget 向量化) */
  addTeamMemory(channelId: string, callerAgentId: string, input: { title: string, content: string, importance?: number, dedupKey?: string }, opts: { byOwner?: boolean } = {}): MemoryRow[] {
    // byOwner:人类 owner 策展(与 lead 同权;curator 身份以 __team__ 哨兵入事件)
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller || caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可写团队记忆')
    }
    const dedupKey = input.dedupKey ?? `manual:${randomUUID()}`
    this.deps.repos.memories.upsert({
      channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey,
    })
    // 策展行同样入向量域(未切分原文;provider 未配置/失败 → 静默留 FTS)
    void vectorizeMemory(this.deps.repos.memories, this.memoryEmbedder, channelId, TEAM_AGENT_ID, dedupKey, input.content).catch(() => {})
    this.buses.get(channelId)?.notifyMemory({ agentId: callerAgentId, scope: 'shared', title: input.title, dedupKey })
    return this.listTeamMemories(channelId)
  }

  /** 删团队记忆(仅 lead;vec 行残留由维护任务统一清理) */
  deleteTeamMemory(channelId: string, callerAgentId: string, memoryId: string, opts: { byOwner?: boolean } = {}): void {
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller || caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可删团队记忆')
    }
    const row = this.deps.repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, 1_000_000).find(r => r.id === memoryId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `团队记忆不存在: ${memoryId}`)
    this.deps.repos.memories.delete(memoryId)
  }

  /** 手动触发记忆衰减清理(REST 透传;策略与定时器同一函数) */
  runMemoryMaintenanceNow(): MaintenanceResult & { retiredByExpiry: number } {
    const result = runMemoryMaintenance(this.deps.repos.memories)
    // RSI(WP-A5):同一次维护顺带执行经验过期退休(与定时器口径一致)
    const retiredByExpiry = this.deps.repos.memories.expireSweep()
    return { ...result, retiredByExpiry }
  }

  /**
   * RSI 经验看板(WP-A5;REST 只读):本 channel 经验条目的生命周期/作用域/极性分布 +
   * 最近条目摘要。数据面 = agent_memories.kind='experience'(WP-A1/A2 产出)。
   */
  experienceOverview(channelId: string): {
    lineId: string | null
    total: number
    byStatus: Record<string, number>
    byScope: Record<string, number>
    byOutcome: Record<string, number>
    recent: Array<{ id: string, title: string, outcome: string, status: string, scopeKind: string, scopeKey: string, taskId: string | null, createdAt: string }>
  } {
    const statuses = ['active', 'candidate', 'validated', 'contested', 'retired'] as const
    const scopeKinds = ['session', 'channel', 'line', 'product', 'global'] as const
    const rows = scopeKinds.flatMap(scopeKind => this.deps.repos.memories.listByScope({
      scopeKind,
      channelIds: [channelId],
      statuses: [...statuses],
      limit: 500,
    }))
    const count = (pick: (r: (typeof rows)[number]) => string): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const r of rows) {
        const k = pick(r)
        out[k] = (out[k] ?? 0) + 1
      }
      return out
    }
    return {
      lineId: this.deps.repos.memories.channelScope(channelId).lineId,
      total: rows.length,
      byStatus: count(r => r.status ?? 'active'),
      byScope: count(r => r.scopeKind ?? 'session'),
      byOutcome: count(r => r.outcome ?? 'neutral'),
      recent: rows
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20)
        .map(r => ({
          id: r.id,
          title: r.title,
          outcome: r.outcome ?? 'neutral',
          status: r.status ?? 'active',
          scopeKind: r.scopeKind ?? 'session',
          scopeKey: r.scopeKey ?? '',
          taskId: r.taskId,
          createdAt: r.createdAt,
        })),
    }
  }

  /**
   * RSI 元层成效看板(WP-C3;REST 只读):按 action_kind 聚合成功率(事实计数)。
   * 口径:accepted+promoted 视为成功;无动作时返回空数组,不报错。
   */
  improvementOverview(channelId: string): {
    channelId: string
    stats: Array<{ actionKind: string, total: number, success: number, rate: number }>
  } {
    return { channelId, stats: createImprovementActionRepo(this.deps.db).stats(channelId) }
  }

  // ===== Agent 私有记忆策展(本人或 lead 写/删;kind='semantic' 人工策展)=====

  /** 写/更新 Agent 私有记忆(caller 须为本人或 lead;稳定 dedupKey 幂等刷新)。
   *  scope='shared'(caller 任意成员)→ 落 Channel 公共域(agent:<caller>:<key> 命名空间,全员可检索)。 */
  addAgentMemory(channelId: string, callerAgentId: string, targetAgentId: string, input: { title: string, content: string, importance?: number, dedupKey?: string, scope?: 'private' | 'shared' }, opts: { byOwner?: boolean } = {}): void {
    // byOwner:人类 owner 策展任意成员记忆(本人/lead 校验旁路;curator 以目标成员入事件)
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller) throw new AppError(403, 'SCOPE_VIOLATION', '调用方 Agent 不在本 channel')
      if (input.scope !== 'shared' && callerAgentId !== targetAgentId && caller.role !== 'lead') {
        throw new AppError(403, 'SCOPE_VIOLATION', '仅本人或 lead 可策展 Agent 记忆')
      }
    }
    if (input.scope === 'shared') {
      // 共享域:走 AgentMemory.save 同源路径(命名空间 dedup + 自动向量化)
      const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: callerAgentId, embedder: this.memoryEmbedder ?? undefined })
      void mem.save({
        title: input.title,
        content: input.content,
        importance: input.importance,
        scope: 'shared',
        dedupKey: input.dedupKey,
      }).then(saved => this.buses.get(channelId)?.notifyMemory({ agentId: callerAgentId, scope: 'shared', title: input.title, dedupKey: saved.dedupKey })).catch(() => {})
      return
    }
    if (!this.deps.repos.channelAgents.findByChannelAgent(channelId, targetAgentId)) {
      throw new AppError(404, 'NOT_FOUND', `Agent 实例不存在: ${targetAgentId}`)
    }
    const dedupKey = input.dedupKey ?? `manual:${randomUUID()}`
    this.deps.repos.memories.upsert({
      channelId,
      agentId: targetAgentId,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey,
    })
    // 策展行同样入向量域(未切分原文;provider 未配置/失败 → 静默留 FTS)
    void vectorizeMemory(this.deps.repos.memories, this.memoryEmbedder, channelId, targetAgentId, dedupKey, input.content).catch(() => {})
    this.buses.get(channelId)?.notifyMemory({ agentId: targetAgentId, scope: 'private', title: input.title, dedupKey })
  }

  /** 删 Agent 私有记忆(caller 须为本人或 lead;行须属该 agent) */
  deleteAgentMemory(channelId: string, callerAgentId: string, targetAgentId: string, memoryId: string, opts: { byOwner?: boolean } = {}): void {
    if (!opts.byOwner) {
      const caller = this.deps.repos.channelAgents.findByChannelAgent(channelId, callerAgentId)
      if (!caller || (callerAgentId !== targetAgentId && caller.role !== 'lead')) {
        throw new AppError(403, 'SCOPE_VIOLATION', '仅本人或 lead 可删除 Agent 记忆')
      }
    }
    const row = this.deps.repos.memories.listByAgent(targetAgentId, 10_000)
      .find(r => r.id === memoryId && r.channelId === channelId && r.agentId === targetAgentId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `记忆不存在: ${memoryId}`)
    this.deps.repos.memories.delete(memoryId)
  }

  /** 实例详情(含运行时装配状态) */
  getChannelAgent(instanceId: string): (AgentInfo & { wired: boolean, runtimeState: 'idle' | 'busy' | 'stopped' | null }) | undefined {
    const m = this.deps.repos.channelAgents.findById(instanceId)
    if (!m) return undefined
    const rt = this.runtimeOf(m.channelId, instanceId)
    return {
      ...instanceToAgentInfo(m),
      wired: rt !== undefined,
      runtimeState: rt ? rt.getState() : null,
    }
  }

  /** 更新实例(name/harness/config/enabled);变更后卸载已装配运行时以重载 */
  async updateChannelAgent(
    instanceId: string,
    patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number },
    meta?: { channelId?: string, by?: string, reason?: string, actor?: SpawnActor },
  ): Promise<AgentInfo> {
    const m = this.deps.repos.channelAgents.findById(instanceId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    const nextConfig = patch.config ?? parseJson<Record<string, unknown>>(m.configJson, {})
    assertSpawnConfigPatchAllowed(patch.harness ?? m.harness, parseJson<Record<string, unknown>>(m.configJson, {}), nextConfig, meta?.actor ?? { role: 'user' })
    if (patch.harness) assertHarnessUsable(patch.harness, nextConfig)
    const updated = this.deps.repos.channelAgents.update(instanceId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    await this.unloadAgent(updated.channelId, instanceId)
    this.notifyMember(updated.channelId, {
      op: 'updated',
      agentId: instanceId,
      name: updated.name,
      role: updated.role as 'lead' | 'worker',
      harness: updated.harness,
      enabled: updated.enabled,
      config: parseJson<Record<string, unknown>>(updated.configJson, {}),
      by: meta?.by ?? 'user',
      reason: meta?.reason,
    })
    return instanceToAgentInfo(updated)
  }

  /** 从 channel 移除实例(仅删实例,不删模板) */
  async removeAgentFromChannel(channelId: string, instanceId: string, meta?: { by?: string, reason?: string }): Promise<void> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, instanceId)
    if (!m) return
    await this.stopAndDetach(channelId, instanceId)
    if (m.role === 'lead') {
      this.deps.repos.channels.update(channelId, { leadAgentId: null })
    }
    this.deps.repos.subscriptions.removeByAgent(channelId, instanceId)
    this.deps.repos.channelAgents.remove(channelId, instanceId)
    this.notifyMember(channelId, {
      op: 'removed',
      agentId: instanceId,
      name: m.name,
      role: m.role as 'lead' | 'worker',
      harness: m.harness,
      enabled: m.enabled,
      by: meta?.by ?? 'user',
      reason: meta?.reason,
    })
  }

  // ===== Lead 自主团队管理面(执行中扩容/调参/裁撤;工具桥 + 调度决策共用) =====

  // ===== P2 多会话（plan 2026-11-06-channel-multi-session-runtime-plan.md S1）=====

  /**
   * 创建会话：从频道基础成员克隆独立 agent 实例组（每 clone 一个独立 runtime/
   * mailbox/omp 进程），注册 channel_sessions 行。同 member 的会话间并行、
   * 会话内串行（execLock 按 runtime 成立）。
   */
  async createChannelSession(input: {
    channelId: string
    actor: { id: string, role: string }
    title?: string
  }): Promise<{ sessionId: string, title: string, members: Array<{ baseAgentId: string, cloneId: string, name: string, role: string }> }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const result = await createChannelSession(
      {
        channelAgents: this.deps.repos.channelAgents as unknown as SessionCloneDeps['channelAgents'],
        tasks: this.getTaskEngine(),
        bindings: getAgentNodeBindingRepo(),
        unloadAgent: (cid, iid) => this.unloadAgent(cid, iid),
        notify: (cid, payload) => this.notifyMember(cid, { ...payload, enabled: 1, by: 'session', reason: 'session create' }),
      },
      {
        channelId: input.channelId,
        actorId: input.actor.id,
        title: input.title,
        sessionRepo: createChannelSessionRepo(this.deps.db),
      },
    )
    this.getSessionContextService().refresh(result.sessionId)
    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'channel.session.create',
      kind: 'system',
      targetKind: 'channel',
      targetId: input.channelId,
      summary: `创建会话 ${result.sessionId.slice(0, 8)}（克隆 ${result.members.length} 个成员实例）`,
      detail: { sessionId: result.sessionId, members: result.members },
    })
    return result
  }

  /** 关闭会话：在飞任务按树取消 + clone 实例停用（runtime 卸载）+ 会话 closed（终态）。 */
  async closeChannelSession(input: {
    channelId: string
    sessionId: string
    actor: { id: string, role: string }
    reason?: string
  }): Promise<{ canceledTasks: number, clones: string[] }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const result = await closeChannelSession(
      {
        channelAgents: this.deps.repos.channelAgents as unknown as SessionCloneDeps['channelAgents'],
        tasks: this.getTaskEngine(),
        bindings: getAgentNodeBindingRepo(),
        unloadAgent: (cid, iid) => this.unloadAgent(cid, iid),
        // WP2：会话关闭走强制摘除（先摘索引再停机），绕过 idle/pending 闸门防僵尸克隆。
        stopAgentRuntime: (cid, iid) => this.stopAndDetach(cid, iid),
        // 取消任务只改状态；正在跑的 LLM 回合要显式打断，否则 clone 会继续烧预算。
        abortTask: (cid, iid, tid) => {
          this.runtimeOf(cid, iid)?.abortTask?.(tid)
        },
        // 已关闭会话的 clone 行停用（ensureAgentRuntime 另有会话 active 守卫兜底）。
        disableAgent: (_cid, iid) => {
          this.deps.repos.channelAgents.update(iid, { enabled: 0 })
        },
        notify: (cid, payload) => this.notifyMember(cid, { ...payload, by: 'session' }),
      },
      {
        channelId: input.channelId,
        sessionId: input.sessionId,
        actorId: input.actor.id,
        reason: input.reason ?? 'owner closed session',
        sessionRepo: createChannelSessionRepo(this.deps.db),
      },
    )
    this.getSessionContextService().refresh(input.sessionId)
    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'channel.session.close',
      kind: 'system',
      targetKind: 'channel',
      targetId: input.channelId,
      summary: `关闭会话 ${input.sessionId.slice(0, 8)}（取消在飞任务 ${result.canceledTasks} 个）`,
      detail: { sessionId: input.sessionId, canceledTasks: result.canceledTasks },
    })
    return result
  }

  /** 会话清单（含每会话成员映射）。 */
  listChannelSessions(channelId: string): ChannelSessionRow[] {
    return createChannelSessionRepo(this.deps.db).listByChannel(channelId)
  }

  /** 会话详情（不存在 → undefined）。 */
  getChannelSession(sessionId: string): ChannelSessionRow | undefined {
    return createChannelSessionRepo(this.deps.db).findById(sessionId)
  }

  /**
   * 项目任务实例（plan 2026-11-07）：为工作项创建专属执行 Channel + 会话行。
   * 返回实例 Channel 与其 lead（root 任务 assignee）。幂等由调用方（项目派发）负责。
   */
  async createTaskInstance(input: {
    projectId: string
    workItemId: string
    templateChannelId: string
    title: string
    actor: { id: string, role: string }
  }): Promise<{
    sessionId: string
    channelId: string
    leadAgentId: string
    members: Array<{ templateAgentId: string, instanceId: string, name: string, role: string }>
  }> {
    const template = this.deps.repos.channels.findById(input.templateChannelId)
    if (!template) throw new AppError(404, 'NOT_FOUND', `模板 Channel 不存在: ${input.templateChannelId}`)
    this.requireWritable(template.ownerUserId, input.actor, 'channel')
    const result = await createTaskInstanceChannel(
      {
        channels: { findById: id => this.deps.repos.channels.findById(id) },
        channelAgents: this.deps.repos.channelAgents as unknown as TaskInstanceDeps['channelAgents'],
        bindings: getAgentNodeBindingRepo(),
        sessions: createChannelSessionRepo(this.deps.db) as unknown as TaskInstanceDeps['sessions'],
        createChannel: ch => this.createChannel({
          ...ch,
          actor: { id: input.actor.id, role: input.actor.role },
        }),
        notify: (cid, payload) => this.notifyMember(cid, { ...payload, enabled: 1, by: 'project', reason: 'task instance' }),
      },
      {
        projectId: input.projectId,
        workItemId: input.workItemId,
        templateChannelId: input.templateChannelId,
        title: input.title,
        actorId: input.actor.id,
      },
    )
    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'project.task.instance.create',
      kind: 'system',
      targetKind: 'channel',
      targetId: result.channelId,
      summary: `任务实例 ${result.channelId.slice(0, 8)}（会话 ${result.sessionId.slice(0, 8)}，克隆 ${result.members.length} 个成员实例）`,
      detail: { projectId: input.projectId, workItemId: input.workItemId, sessionId: result.sessionId, members: result.members },
    })
    return result
  }
}
