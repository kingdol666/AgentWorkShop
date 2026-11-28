/**
 * ManagerAdminAgents —— Channel 实例管理、记忆与成员增改删
 * (拆分层,承 ManagerAdminChannel)
 */
import { ManagerAdminChannel } from './admin-channel'
import type { AgentInfo } from '../../agents/agent-interface'
import type { MaintenanceResult, MemorySnippet } from '../memory'
import type { ChannelAgentCreationSource, ChannelAgentRow, MemoryRow } from '../../db/database/rows'
import { AgentMemory, runMemoryMaintenance, segmentCJK, unsegmentCJK, vectorizeMemory } from '../memory'
import { AppError } from '../../../../utils/errors'
import { TEAM_AGENT_ID } from '../../db/memory.repo'
import { assertHarnessUsable } from '../../agents/harness-availability'
import { harnessToolSurface } from '../../agents/registry'
import { assertSpawnConfigAllowed, assertSpawnConfigPatchAllowed, type SpawnActor } from '../../agents/harness-spawn-policy'
import { applyProfileToConfig, profileSelectionChanged } from '../../agent-prefabs/profile'
import { validateMemberHarnessChange } from '../../sessions/member-harness'
import { instanceToAgentInfo, log } from './helpers'
import { createChannelSession, closeChannelSession, reconcileClosingSessions, activeSessionIdOfMember, activeSessionOfMember, frozenBindingMembers, isUnclosedSessionClone, SESSION_MARKER } from '../../agents/session-clone'
import { createChannelSessionBindingSnapshot, resolveTrustedSessionBinding } from '../../agents/session-snapshot'
import { createChannelProductBindingRepo } from '../../db/channel-product-binding.repo'
import { getDcwProductRepo } from '../../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { executionModeOfChannel } from '../../agents/execution-mode'
import { createTaskInstanceChannel } from '../../agents/task-channel'
import type { TaskInstanceDeps, TaskInstancePrefabOptions } from '../../agents/task-channel'
import { getAgentNodeBindingRepo } from '../../agents/node-bindings.repo'
import { assertSessionPurgeable, cloneIdsOf, purgeArchivedSessionData, type SessionPurgeCounts } from '../../agents/session-purge'
import { createChannelSessionRepo, type ChannelSessionRow } from '../../db/channel-session.repo'
import type { SessionCloneDeps } from '../../agents/session-clone'
import { parseJson } from '../../db/database'
import { createImprovementActionRepo } from '../../db/improvement-action.repo'
import { withTransaction } from '../../db/transaction'
import { workshopSettings } from '../../settings'
import { selectBroadcastTargets } from './broadcast-targets'
import { ensurePrefabBindingVersion } from '../../db/channel-agent.repo'
import { randomUUID } from 'node:crypto'
import { createSessionRuntimeService, type SessionRuntimeView } from '../../sessions/runtime-service'
import { createSessionBindingService, type SessionBindingView } from '../../sessions/session-binding-service'
import type { ActingUser } from './types'

export function assertPrefabBindingActiveAtWrite(db: Parameters<typeof withTransaction>[0], raw: string | undefined): void {
  if (!raw) return
  const parsed = parseJson<Record<string, unknown>>(raw, {})
  const prefabId = typeof parsed.prefabId === 'string' ? parsed.prefabId : ''
  if (!prefabId) return
  const row = db.prepare('SELECT archived_at AS archivedAt FROM agent_prefabs WHERE id = ?').get(prefabId) as { archivedAt: string | null } | undefined
  if (row?.archivedAt) throw new AppError(409, 'PREFAB_ARCHIVED', 'AgentPrefab 已归档，不能用于新的绑定')
}

type AddChannelAgentInput = Partial<ChannelAgentCreationSource> & {
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
  /** 模板/Channel 模板携带的 AgentPrefab 绑定 JSON（缺省无绑定） */
  prefabBindingJson?: string
}

export abstract class ManagerAdminAgents extends ManagerAdminChannel {
  /** 把 Agent 模板放入 channel → 克隆出独立身份 id 的新实例(复制 name/harness/config) */
  async addAgentToChannel(input: AddChannelAgentInput): Promise<AgentInfo> {
    const inst = this.insertChannelAgent(input)
    this.notifyChannelAgentAdded(inst, input)
    return instanceToAgentInfo(inst)
  }

  /** Synchronous DB-only path; callers owning a transaction notify only after commit. */
  protected insertChannelAgent(input: AddChannelAgentInput): ChannelAgentRow {
    const tpl = this.deps.repos.agents.findById(input.agentId)
    if (!tpl) throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${input.agentId}`)
    const instConfig = applyProfileToConfig(tpl.harness, { ...parseJson<Record<string, unknown>>(tpl.configJson, {}), ...input.configOverride })
    // 服务层收权：不能只在 REST 入口校验，lead/MCP/模板/调度路径也必须过同一门。
    assertSpawnConfigAllowed(tpl.harness, instConfig, input.actor ?? { role: 'user' })
    // 绑定即执行入口:引擎未安装的模板不许入 channel(deploy/加成员在此失败,不产生半成品实例)
    assertHarnessUsable(tpl.harness, instConfig)
    assertPrefabBindingActiveAtWrite(this.deps.db, input.prefabBindingJson)
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
      prefabBindingJson: ensurePrefabBindingVersion(input.prefabBindingJson ?? ''),
      role: input.role,
      createdByKind: input.createdByKind,
      createdById: input.createdById,
      createdVia: input.createdVia,
      createdReason: input.createdReason,
    })
    if (input.role === 'lead') {
      this.deps.repos.channels.update(input.channelId, { leadAgentId: inst.id })
    }
    return inst
  }

  protected notifyChannelAgentAdded(inst: ChannelAgentRow, meta: { by?: string, reason?: string }): void {
    this.notifyMember(inst.channelId, {
      op: 'added',
      agentId: inst.id,
      name: inst.name,
      role: inst.role as 'lead' | 'worker',
      harness: inst.harness,
      enabled: inst.enabled,
      config: parseJson<Record<string, unknown>>(inst.configJson, {}),
      by: meta.by ?? 'user',
      reason: meta.reason,
    })
  }

  async listChannelAgents(channelId: string): Promise<AgentInfo[]> {
    return this.deps.repos.channelAgents.listByChannel(channelId).map(instanceToAgentInfo)
  }

  /**
   * 广播目标面(会话隔离):基础成员 + 发起者所属会话的 clone。
   * 发起者是基础成员(频道 lead)→ 频道级全量,保持既有语义;是会话 clone →
   * 按 session memberMap 收窄,不把会话内广播扇出到别的会话。
   */
  async listBroadcastTargets(channelId: string, senderAgentId: string): Promise<AgentInfo[]> {
    const agents = await this.listChannelAgents(channelId)
    const sessions = createChannelSessionRepo(this.deps.db).listByChannel(channelId)
    const sessionId = activeSessionIdOfMember(sessions, senderAgentId)
    const memberIds = sessionId
      ? new Set(Object.values(parseJson<Record<string, string>>(
          sessions.find(s => s.id === sessionId)?.memberMapJson ?? '{}',
          {},
        )))
      : null
    return selectBroadcastTargets(agents, senderAgentId, memberIds)
  }

  /** Agent 记忆列表(私有观察面;content 还原为未切分原文,客户端可读):实例须存在于本 channel */
  listMemories(channelId: string, agentId: string, limit = 50): MemoryRow[] {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${agentId}`)
    // 与 delete 路径同口径：按 channel 过滤（旧实现用 listByAgent，会跨 channel 返回该 agent 全部私有记忆）
    return this.deps.repos.memories.listByAgentChannel(channelId, agentId, limit)
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
    // Agent caller may only inspect their own private/session domain; owner UI may choose a target.
    if (!opts.byOwner) {
      this.requireMember(channelId, callerAgentId)
      if (callerAgentId !== targetAgentId) throw new AppError(403, 'MEMORY_OWNER_REQUIRED', 'Agent 只能检索自己的私有记忆')
    }
    if (!this.deps.repos.channelAgents.findByChannelAgent(channelId, targetAgentId)) {
      throw new AppError(404, 'NOT_FOUND', `Agent 实例不存在: ${targetAgentId}`)
    }
    const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: targetAgentId })
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
    const write = this.deps.repos.memories.upsert({
      channelId,
      agentId: TEAM_AGENT_ID,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey,
    }, opts.byOwner ? { kind: 'human', id: callerAgentId } : { kind: 'agent', id: callerAgentId })
    // 受保护行(人工/已验证)不改写：跳过向量化与"已更新"事件，避免正文与向量不一致
    if (write.outcome !== 'protected') {
      void vectorizeMemory(this.deps.repos.memories, this.memoryEmbedder, channelId, TEAM_AGENT_ID, dedupKey, input.content).catch(() => {})
      this.buses.get(channelId)?.notifyMemory({ agentId: callerAgentId, scope: 'shared', title: input.title, dedupKey })
    }
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
      const mem = new AgentMemory(this.deps.repos.memories, { channelId, agentId: callerAgentId })
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
    const write = this.deps.repos.memories.upsert({
      channelId,
      agentId: targetAgentId,
      kind: 'semantic',
      title: input.title,
      titleFts: segmentCJK(input.title),
      content: segmentCJK(input.content).slice(0, 800),
      importance: input.importance ?? 0.9,
      taskId: null,
      dedupKey,
    }, opts.byOwner ? { kind: 'human', id: callerAgentId } : { kind: 'agent', id: callerAgentId })
    if (write.outcome === 'protected') return
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
    const row = this.deps.repos.memories.listByAgentChannel(channelId, targetAgentId, 10_000)
      .find(r => r.id === memoryId)
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

  private assertPrefabBindingChangeSafeSync(member: ChannelAgentRow): void {
    const runtime = this.runtimeOf(member.channelId, member.id)
    if (runtime?.getState() === 'busy' || runtime?.hasActiveSupervisionAttempt?.()) {
      throw new AppError(409, 'PREFAB_BINDING_BUSY', '成员正在执行回合或监督任务，请等待空闲后再修改 AgentPrefab 绑定')
    }
    const tasks = this.getTaskEngine().list(member.channelId)
    if (tasks.some(task => task.assigneeId === member.id && !['COMPLETED', 'CANCELED', 'FAILED', 'SUPERSEDED'].includes(task.state))) {
      throw new AppError(409, 'PREFAB_BINDING_BUSY', '成员存在未完成任务，请等待任务收敛后再修改 AgentPrefab 绑定')
    }
    if (this.deps.repos.messages.hasUnconsumedByChannelAgent(member.channelId, member.id)) {
      throw new AppError(409, 'PREFAB_BINDING_BUSY', '成员存在待处理消息，请等待消息消费后再修改 AgentPrefab 绑定')
    }
    if (frozenBindingMembers(createChannelSessionRepo(this.deps.db).listByChannel(member.channelId)).has(member.id)) {
      throw new AppError(409, 'PREFAB_BINDING_FROZEN', '会话或项目任务实例成员的绑定快照已冻结，不能修改')
    }
  }

  private async assertPrefabBindingChangeSafe(member: ChannelAgentRow): Promise<void> {
    try {
      const { getToolApprovals } = await import('../../agents/tool-approvals')
      if (getToolApprovals().listPending(member.id).length > 0) {
        throw new AppError(409, 'PREFAB_BINDING_BUSY', '成员存在待处理审批，请等待审批收敛后再修改 AgentPrefab 绑定')
      }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      // Approval service may be absent in a reduced test/runtime build.
    }
    // This must remain after the asynchronous approval lookup. Callers perform
    // the SQL mutation synchronously after this resolves, with no further await.
    this.assertPrefabBindingChangeSafeSync(member)
  }

  /** 更新实例(name/harness/config/enabled);变更后卸载已装配运行时以重载 */
  async updateChannelAgent(
    instanceId: string,
    patch: { name?: string, harness?: string, config?: Record<string, unknown>, enabled?: number, prefabBindingJson?: string, expectedBindingVersion?: string },
    meta?: { channelId?: string, by?: string, reason?: string, actor?: SpawnActor },
  ): Promise<AgentInfo> {
    const m = this.deps.repos.channelAgents.findById(instanceId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    if (meta?.channelId && meta.channelId !== m.channelId) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
    const bindingChange = patch.prefabBindingJson !== undefined
    if (patch.prefabBindingJson) {
      if ((m.prefabBindingJson ?? '') !== '') {
        throw new AppError(409, 'PREFAB_ALREADY_BOUND', '成员已绑定 AgentPrefab；不允许替换绑定')
      }
      assertPrefabBindingActiveAtWrite(this.deps.db, patch.prefabBindingJson)
    }
    if (bindingChange) await this.assertPrefabBindingChangeSafe(m)
    const targetHarness = patch.harness ?? m.harness
    const currentConfig = parseJson<Record<string, unknown>>(m.configJson, {})
    // harness/config 变更时把 provider/model/effort 归一成目标引擎真实读取的键
    // （omp thinkingLevel / opencode variant+限定 model / pi thinking）。
    const changedProfile = Boolean(patch.harness && patch.harness !== m.harness)
      || (patch.config ? profileSelectionChanged(currentConfig, patch.config) : false)
    if (changedProfile) {
      // 活动会话的 clone：runtime 元数据必须走会话级覆盖（CAS + dry-run + 下一回合热切换）。
      // 直接改 clone 行会绕开会话覆盖并造成 wire 期冲突。
      const activeSession = activeSessionOfMember(createChannelSessionRepo(this.deps.db).listByChannel(m.channelId), m.id)
      if (activeSession) {
        throw new AppError(409, 'SESSION_RUNTIME_API_REQUIRED',
          `该成员属于活动会话（${activeSession.id.slice(0, 8)}）：请在会话详情「运行实例」中修改 harness/模型；直接改成员行会与会话覆盖冲突`)
      }
    }
    const nextConfig = changedProfile
      ? applyProfileToConfig(targetHarness, patch.config ?? currentConfig)
      : (patch.config ?? currentConfig)
    const effectivePatch = changedProfile ? { ...patch, config: nextConfig } : patch
    assertSpawnConfigPatchAllowed(targetHarness, currentConfig, nextConfig, meta?.actor ?? { role: 'user' })
    if (patch.harness) assertHarnessUsable(patch.harness, nextConfig)
    if (patch.harness && patch.harness !== m.harness) {
      // 预检必须在事务之前：否则 PATCH 成功、下一回合装配才 409（旧实现的实际缺陷）。
      validateMemberHarnessChange(this.deps.db, m, patch.harness, nextConfig)
    }
    if (bindingChange) {
      const current = this.deps.repos.channelAgents.findById(instanceId)
      if (current) this.assertPrefabBindingChangeSafeSync(current)
    }
    const updated = withTransaction(this.deps.db, () => {
      const current = this.deps.repos.channelAgents.findById(instanceId)
      if (!current) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
      if (meta?.channelId && meta.channelId !== current.channelId) throw new AppError(404, 'NOT_FOUND', `实例不存在: ${instanceId}`)
      if (bindingChange) this.assertPrefabBindingChangeSafeSync(current)
      // Binding mutations have their own SQLite CAS. Never route them through the
      // generic member UPDATE, which would permit replacing a pinned revision.
      if (effectivePatch.prefabBindingJson !== undefined) {
        if (effectivePatch.prefabBindingJson) assertPrefabBindingActiveAtWrite(this.deps.db, effectivePatch.prefabBindingJson)
        this.deps.repos.channelAgents.setPrefabBinding(
          current.channelId,
          instanceId,
          effectivePatch.prefabBindingJson,
          effectivePatch.expectedBindingVersion,
        )
      }
      const memberPatch = effectivePatch.prefabBindingJson === undefined
        ? effectivePatch
        : { ...effectivePatch, prefabBindingJson: undefined }
      this.deps.repos.channelAgents.update(instanceId, memberPatch)
      return this.deps.repos.channelAgents.findById(instanceId)!
    })
    // No await between commit and stopAndDetach: its synchronous tombstone
    // prevents callers from re-wiring the pre-change runtime while it stops.
    const bindingStop = bindingChange && this.runtimeOf(updated.channelId, instanceId)
      ? this.stopAndDetach(updated.channelId, instanceId)
      : undefined
    if (bindingStop) await bindingStop
    else if (!bindingChange) await this.unloadAgent(updated.channelId, instanceId)
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

  protected assertRemovableChannelAgent(member: ChannelAgentRow): void {
    if (member.agentKind === 'project_leader' || member.role === 'lead'
      || this.deps.repos.channels.findById(member.channelId)?.leadAgentId === member.id) {
      throw new AppError(409, 'CHANNEL_AGENT_PROTECTED', '不能从频道直接删除 lead 或项目 leader')
    }
    const sessions = createChannelSessionRepo(this.deps.db).listByChannel(member.channelId)
    if (isUnclosedSessionClone(sessions, member.id)) {
      throw new AppError(409, 'CHANNEL_AGENT_PROTECTED', '不能删除未关闭会话中的成员实例，请先关闭会话')
    }
  }

  /** 从 channel 移除实例(仅删实例,不删模板) */
  async removeAgentFromChannel(channelId: string, instanceId: string, meta?: { by?: string, reason?: string }): Promise<void> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, instanceId)
    if (!m) return
    this.assertRemovableChannelAgent(m)
    await this.stopAndDetach(channelId, instanceId)
    const removed = withTransaction(this.deps.db, () => {
      const current = this.deps.repos.channelAgents.findByChannelAgent(channelId, instanceId)
      if (!current) return false
      this.assertRemovableChannelAgent(current)
      // 等运行时收尾，再于同一事务取消未消费投递和删除成员，避免重试或取消状态被收尾覆盖。
      this.chatMessageRepo.cancelPendingDeliveriesForAgent(channelId, instanceId)
      this.deps.repos.subscriptions.removeByAgent(channelId, instanceId)
      this.deps.repos.channelAgents.remove(channelId, instanceId)
      return true
    })
    if (!removed) return
    // 节点绑定由 JSON 存储，不参与 SQLite 事务；只清理这个实例的绑定，不动模板/其他成员。
    try {
      getAgentNodeBindingRepo().removeAgent(instanceId)
    }
    catch (err) {
      log.warn(`[workshop] 清理已删除实例 ${instanceId} 的节点绑定失败:`, err)
    }
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
  async createChannelSession(input: Partial<ChannelAgentCreationSource> & {
    channelId: string
    actor: { id: string, role: string }
    title?: string
    productId?: string
    /** 会话记忆策略(缺省 session):shared 允许写 line/global 经验 */
    memoryPolicy?: 'session' | 'shared'
  }): Promise<{ sessionId: string, title: string, channelMode: import('../../db/database/rows').ChannelMode, productId?: string, lineId?: string, bindingSnapshotHash?: string, bindingSnapshotRevision?: number, members: Array<{ baseAgentId: string, cloneId: string, name: string, role: string }> }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const channelMode = this.channelModeOf(input.channelId)
    const bases = this.deps.repos.channelAgents.listByChannel(input.channelId).filter((agent) => {
      if (agent.enabled !== 1 || agent.agentKind === 'project_leader' || String(agent.name ?? '').includes('·session·')) return false
      return agent.role === 'lead' || agent.role === 'worker'
    })
    const bindingRepo = createChannelProductBindingRepo(this.deps.db)
    let bindingRevision = 0
    let snapshot: ReturnType<typeof createChannelSessionBindingSnapshot> | undefined
    let baseBindings: Array<{ agentId: string, bindings: Array<{ nodeId: string, kind: string, mode: string, tuning: unknown }> }> = []
    if (channelMode === 'production_line_integrated') {
      if (!input.productId) throw new AppError(400, 'SESSION_PRODUCT_REQUIRED', '集成产线会话必须选择已绑定产品')
      const boundProductIds = bindingRepo.listByChannel(input.channelId).map(binding => binding.productId)
      if (!boundProductIds.includes(input.productId)) {
        throw new AppError(403, 'SESSION_PRODUCT_NOT_BOUND', `产品 ${input.productId} 未绑定到当前 Channel`)
      }
      const product = getDcwProductRepo().byId(input.productId)
      if (!product || !product.lineId) throw new AppError(404, 'SESSION_PRODUCT_NOT_FOUND', `产品不存在或未绑定产线: ${input.productId}`)
      if (channel.lineId && channel.lineId !== product.lineId) throw new AppError(409, 'SESSION_PRODUCT_LINE_MISMATCH', '产品所属产线与 Channel 当前产线不一致')
      const allAgentBindings = getAgentNodeBindingRepo()
      baseBindings = bases.map(agent => ({ agentId: agent.id, bindings: allAgentBindings.byAgent(agent.id).map(binding => ({ nodeId: binding.nodeId, kind: binding.kind, mode: binding.mode, tuning: binding.tuning })) }))
      bindingRevision = bindingRepo.getRevision(input.channelId)
      snapshot = createChannelSessionBindingSnapshot({
        channelId: input.channelId,
        selectedProductId: input.productId,
        lineId: product.lineId,
        bindingRevision,
        boundProductIds,
        recipes: getDcwRecipeRepo().list().filter(recipe => recipe.productId === input.productId).map(recipe => ({ id: recipe.id, productId: recipe.productId, lineId: recipe.lineId, version: recipe.version ?? 1, params: recipe.params, daqWindows: recipe.daqWindows ?? [] })),
        agentBindings: baseBindings,
        executionProfile: { mode: executionModeOfChannel(input.channelId) },
      })
    }
    // 并发上限:每个会话克隆全部基础成员(各起独立 runtime/进程),无上限是资源放大器
    const limit = workshopSettings().max_active_sessions_per_channel
    const active = createChannelSessionRepo(this.deps.db).listActive(input.channelId).length
    if (limit > 0 && active >= limit) {
      throw new AppError(429, 'SESSION_LIMIT', `该频道活动会话已达上限(${active}/${limit});请先关闭不用的会话,或调高 workshop.max_active_sessions_per_channel`)
    }
    const bindingRowsByAgent = Object.fromEntries(baseBindings.map(entry => [entry.agentId, entry.bindings]))
    const result = createChannelSession(
      {
        channelAgents: this.deps.repos.channelAgents as unknown as SessionCloneDeps['channelAgents'],
        tasks: this.getTaskEngine(),
        bindings: getAgentNodeBindingRepo(),
        bindingsSnapshot: bindingRowsByAgent,
        bindingSnapshot: snapshot,
        beforeCreate: () => {
          if (snapshot && bindingRepo.getRevision(input.channelId) !== bindingRevision) {
            throw new AppError(409, 'CHANNEL_PRODUCT_BINDING_STALE', 'Channel 产品绑定已变化，请刷新后重新创建会话')
          }
        },
        withTx: fn => withTransaction(this.deps.db, fn),
        compensateSession: (sessionId) => {
          createChannelSessionRepo(this.deps.db).close(sessionId)
        },
        unloadAgent: (cid, iid) => this.unloadAgent(cid, iid),
        notify: (cid, payload) => this.notifyMember(cid, { ...payload, enabled: 1, by: 'session', reason: 'session create' }),
      },
      {
        channelId: input.channelId,
        actorId: input.actor.id,
        createdByKind: input.createdByKind,
        createdById: input.createdById,
        createdVia: input.createdVia,
        createdReason: input.createdReason,
        title: input.title,
        channelMode,
        productId: snapshot?.productId,
        lineId: snapshot?.lineId,
        bindingSnapshot: snapshot,
        bindingsSnapshot: bindingRowsByAgent,
        memoryPolicy: input.memoryPolicy,
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
    return {
      ...result,
      channelMode,
      ...(snapshot ? { productId: snapshot.productId, lineId: snapshot.lineId, bindingSnapshotHash: snapshot.hash, bindingSnapshotRevision: snapshot.revision } : {}),
    }
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

  /** 会话行必须存在且属于该频道（跨频道 sid → 404，避免按 id 越权读删）。 */
  protected requireSessionOfChannel(channelId: string, sessionId: string): ChannelSessionRow {
    const session = createChannelSessionRepo(this.deps.db).findById(sessionId)
    if (!session || session.channelId !== channelId) {
      throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
    }
    return session
  }

  /** 会话改名：只改展示标题（owner/admin；不改会话状态与派发链路）。 */
  async renameChannelSession(input: {
    channelId: string
    sessionId: string
    actor: { id: string, role: string }
    title: string
  }): Promise<{ sessionId: string, title: string }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const session = this.requireSessionOfChannel(input.channelId, input.sessionId)
    if (session.instanceKind !== 'manual') {
      throw new AppError(409, 'SESSION_MANAGED', '项目/任务会话由项目生命周期管理，不能改名')
    }
    const title = String(input.title ?? '').trim()
    if (!title) throw new AppError(400, 'SESSION_TITLE_REQUIRED', '会话名称不能为空')
    if (title.length > 120) throw new AppError(400, 'SESSION_TITLE_TOO_LONG', '会话名称不能超过 120 个字符')
    if (!createChannelSessionRepo(this.deps.db).rename(input.sessionId, title)) {
      throw new AppError(404, 'NOT_FOUND', `会话不存在: ${input.sessionId}`)
    }
    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'channel.session.rename',
      kind: 'system',
      targetKind: 'channel',
      targetId: input.channelId,
      summary: `会话改名 ${input.sessionId.slice(0, 8)} → ${title}`,
      detail: { sessionId: input.sessionId, title },
    })
    return { sessionId: input.sessionId, title }
  }

  /**
   * 归档会话：手工会话专属。active/closing 先走既有 close 级联（取消在飞任务 +
   * 停用全部 clone），再写 archived_at；重复归档幂等。
   */
  async archiveChannelSession(input: {
    channelId: string
    sessionId: string
    actor: { id: string, role: string }
  }): Promise<{ archived: true, archivedAt: string, canceledTasks: number, clones: string[] }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const session = this.requireSessionOfChannel(input.channelId, input.sessionId)
    if (session.instanceKind !== 'manual') {
      throw new AppError(409, 'SESSION_MANAGED', '项目/任务会话由项目生命周期管理，不能归档')
    }
    if (session.archivedAt) {
      return { archived: true, archivedAt: session.archivedAt, canceledTasks: 0, clones: [] }
    }
    let canceledTasks = 0
    if (session.status !== 'closed') {
      const closed = await this.closeChannelSession({
        channelId: input.channelId,
        sessionId: input.sessionId,
        actor: input.actor,
        reason: 'owner archived session',
      })
      canceledTasks = closed.canceledTasks
    }
    // 并发 close 在飞时 closeChannelSession 会立即返回(不等待),不能据此写 archived_at：
    // 有界等待事务对账收敛到 closed；仍 closing 则拒绝归档，避免 archived+closing 半态。
    const sessionRepo = createChannelSessionRepo(this.deps.db)
    let latest = sessionRepo.findById(input.sessionId)
    for (let i = 0; latest && latest.status !== 'closed' && i < 100; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      latest = sessionRepo.findById(input.sessionId)
    }
    if (!latest) throw new AppError(404, 'NOT_FOUND', `会话不存在: ${input.sessionId}`)
    if (latest.status !== 'closed') {
      throw new AppError(409, 'SESSION_CLOSING', '会话正在关闭，请稍后重试归档')
    }
    const clones = cloneIdsOf(latest.memberMapJson)
    const archivedAt = new Date().toISOString()
    if (!sessionRepo.setArchived(input.sessionId, archivedAt)) {
      throw new AppError(404, 'NOT_FOUND', `会话不存在: ${input.sessionId}`)
    }
    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'channel.session.archive',
      kind: 'system',
      targetKind: 'channel',
      targetId: input.channelId,
      summary: `归档会话 ${input.sessionId.slice(0, 8)}（取消在飞任务 ${canceledTasks} 个）`,
      detail: { sessionId: input.sessionId, canceledTasks },
    })
    return { archived: true, archivedAt, canceledTasks, clones }
  }

  /** 恢复已归档会话：回到普通清单（closed 状态保持，不自动重开运行时）。 */
  async restoreChannelSession(input: {
    channelId: string
    sessionId: string
    actor: { id: string, role: string }
  }): Promise<{ restored: true, already: boolean }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const session = this.requireSessionOfChannel(input.channelId, input.sessionId)
    if (session.instanceKind !== 'manual') {
      throw new AppError(409, 'SESSION_MANAGED', '项目/任务会话由项目生命周期管理，不能恢复归档')
    }
    if (!session.archivedAt) return { restored: true, already: true }
    if (!createChannelSessionRepo(this.deps.db).setArchived(input.sessionId, null)) {
      throw new AppError(404, 'NOT_FOUND', `会话不存在: ${input.sessionId}`)
    }
    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'channel.session.restore',
      kind: 'system',
      targetKind: 'channel',
      targetId: input.channelId,
      summary: `恢复会话 ${input.sessionId.slice(0, 8)}`,
      detail: { sessionId: input.sessionId },
    })
    return { restored: true, already: false }
  }

  /**
   * 永久删除已归档会话：停摘残留运行时 → 事务级联清理 DB（会话/克隆/消息/任务/记忆）
   * → 清理 agent-node-bindings.json 持久层。不可恢复，调用方必须已二次确认。
   */
  async purgeChannelSession(input: {
    channelId: string
    sessionId: string
    actor: { id: string, role: string }
  }): Promise<SessionPurgeCounts & { clones: number }> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `Channel 不存在: ${input.channelId}`)
    this.requireWritable(channel.ownerUserId, input.actor, 'channel')
    const session = this.requireSessionOfChannel(input.channelId, input.sessionId)
    // 先验闸门再停摘：未归档/未关闭/项目会话的 409 必须是纯拒绝，不能顺手停掉在跑运行时。
    assertSessionPurgeable(session)
    const clones = cloneIdsOf(session.memberMapJson)

    // 防御性摘除：已关闭会话的运行时理论上已卸载，但绝不能让清理后的进程继续持有旧信箱。
    for (const cloneId of clones) {
      await this.stopAndDetach(input.channelId, cloneId)
    }
    const counts = purgeArchivedSessionData(this.deps.db, session)

    // JSON 持久层不参与 SQLite 事务：DB 已提交后再清理；失败只留孤儿绑定，不复活会话。
    try {
      const bindings = getAgentNodeBindingRepo()
      for (const cloneId of clones) bindings.removeAgent(cloneId)
    }
    catch (err) {
      log.warn(`[workshop] 清理已删除会话 ${input.sessionId.slice(0, 8)} 的节点绑定失败:`, err)
    }

    const { recordOps } = await import('../../ops/ops')
    recordOps({
      actor: input.actor.id,
      actorName: 'owner',
      actorKind: 'user',
      action: 'channel.session.purge',
      kind: 'system',
      targetKind: 'channel',
      targetId: input.channelId,
      summary: `永久删除归档会话 ${input.sessionId.slice(0, 8)}`,
      detail: { sessionId: input.sessionId, ...counts },
    })
    return { ...counts, clones: clones.length }
  }

  /** 当前用户可见（owner/admin）的已归档会话，按归档时间倒序。 */
  listArchivedSessions(actor: { id: string, role: string }): Array<ChannelSessionRow & { channelName: string }> {
    const sessions = createChannelSessionRepo(this.deps.db)
    const visible = this.listChannelsVisibleTo(actor).filter(channel =>
      actor.role === 'admin' || (channel.ownerUserId !== null && channel.ownerUserId === actor.id),
    )
    const archivedTime = (value: string | null): number => {
      const parsed = value ? Date.parse(value) : Number.NaN
      return Number.isFinite(parsed) ? parsed : 0
    }
    return visible
      .flatMap(channel => sessions.listArchivedByChannel(channel.id).map(session => ({ ...session, channelName: channel.name })))
      .sort((a, b) => archivedTime(b.archivedAt) - archivedTime(a.archivedAt))
  }

  /** 会话清单（含每会话成员映射）。 */
  listChannelSessions(channelId: string): ChannelSessionRow[] {
    return createChannelSessionRepo(this.deps.db).listByChannel(channelId)
  }

  /**
   * 启动对账:补齐上次进程在关闭级联中途退出留下的 closing 会话。
   * 由 workshop 插件在装配完成、开始服务请求前同步调用;幂等。
   * @returns 本次收敛为 closed 的会话数
   */
  reconcileInterruptedSessions(): number {
    const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'])
    const closed = reconcileClosingSessions(
      createChannelSessionRepo(this.deps.db),
      (_channelId, cloneId) => {
        this.deps.repos.channelAgents.update(cloneId, { enabled: 0 })
      },
      (channelId, cloneIds) => {
        // 级联中途退出时可能仍有任务挂在 clone 上;仅停用成员不会让这些任务收口。
        const set = new Set(cloneIds)
        const engine = this.getTaskEngine()
        for (const task of engine.list(channelId)) {
          if (!set.has(String(task.assigneeId ?? '')) || terminal.has(task.state)) continue
          engine.cancelTree(task.id, 'system', 'SESSION_CLOSE_RECOVERED')
        }
      },
    )
    if (closed > 0) console.log(`[workshop] 启动对账:补齐 ${closed} 个中断的会话关闭`)
    return closed
  }

  /** 会话详情（不存在 → undefined）。 */
  getChannelSession(sessionId: string): ChannelSessionRow | undefined {
    return createChannelSessionRepo(this.deps.db).findById(sessionId)
  }

  /** 会话 runtime 对象列表（manual/task 均可读；task/project 只读由 service 返回 manageable=false）。 */
  listSessionRuntime(channelId: string, sessionId: string, user: ActingUser): SessionRuntimeView[] {
    this.getChannelForUser(channelId, user.id)
    return createSessionRuntimeService(this.deps.db, { toolSurface: harnessToolSurface }).list(channelId, sessionId)
  }

  getSessionRuntime(channelId: string, sessionId: string, agentId: string, user: ActingUser): SessionRuntimeView {
    this.getChannelForUser(channelId, user.id)
    return createSessionRuntimeService(this.deps.db, { toolSurface: harnessToolSurface }).get(channelId, sessionId, agentId)
  }

  /**
   * 修改单个 manual session runtime 的元数据（provider/model/effort/runtimePrompt/prefab）。
   * 持久化 revision CAS；下一回合消息入口由 runtime 热切换生效，当前回合不打断。
   */
  async updateSessionRuntime(
    channelId: string,
    sessionId: string,
    agentId: string,
    input: { expectedRevision: number, reset?: boolean, overrides?: unknown },
    user: ActingUser & { name?: string },
  ): Promise<SessionRuntimeView> {
    const channel = this.getChannelForUser(channelId, user.id)
    this.requireWritable(channel.ownerUserId, user, 'channel')
    const runtimeService = createSessionRuntimeService(this.deps.db, { toolSurface: harnessToolSurface })
    const before = runtimeService.get(channelId, sessionId, agentId)
    const view = await runtimeService.update({
      channelId,
      sessionId,
      agentId,
      expectedRevision: input.expectedRevision,
      reset: input.reset,
      overrides: input.overrides,
      actor: { id: user.id, role: user.role },
    })
    const changedKeys = input.reset === true
      ? ['reset']
      : Object.keys((input.overrides ?? {}) as Record<string, unknown>)
    try {
      const { recordOps } = await import('../../ops/ops')
      recordOps({
        actor: user.id,
        actorName: user.name ?? '',
        actorKind: 'user',
        action: input.reset === true ? 'channel.session.runtime.reset' : 'channel.session.runtime.update',
        kind: 'manual',
        targetKind: 'session_runtime',
        targetId: view.runtimeObjectId,
        lineId: '',
        summary: `${input.reset === true ? '重置' : '修改'}会话 runtime「${view.name}」(${view.runtimeObjectId.slice(0, 8)}) revision ${view.revision}`,
        detail: {
          sessionId,
          agentId,
          revision: view.revision,
          changedKeys,
          before: {
            harness: before.harness,
            provider: before.effective.provider ?? null,
            model: before.effective.model ?? null,
            effort: before.effective.effort ?? null,
            runtimePromptLength: before.effective.runtimePrompt?.length ?? 0,
            prefabId: before.effective.prefab?.prefabId ?? null,
            prefabRevision: before.effective.prefab?.revision ?? null,
            revision: before.revision,
          },
          after: {
            harness: view.harness,
            provider: view.effective.provider ?? null,
            model: view.effective.model ?? null,
            effort: view.effective.effort ?? null,
            runtimePromptLength: view.effective.runtimePrompt?.length ?? 0,
            prefabId: view.effective.prefab?.prefabId ?? null,
            prefabRevision: view.effective.prefab?.revision ?? null,
            revision: view.revision,
          },
        },
      })
    }
    catch (err) {
      // 审计面失败不改变已提交的 runtime 覆盖；留错误日志供运维补记。
      log.error('[session-runtime] 审计写入失败:', err)
    }
    return view
  }

  /**
   * 显式“重建运行实例”：只入队，真正的重建在下一回合消息入口执行（不打断当前回合）。
   * 未装配的 runtime 无需重建（下一条消息会按最新 DB 装配）。
   */
  requestSessionRuntimeRebuild(
    channelId: string,
    sessionId: string,
    agentId: string,
    user: ActingUser,
  ): { queued: boolean, effectiveAt: 'next_turn' } {
    const channel = this.getChannelForUser(channelId, user.id)
    this.requireWritable(channel.ownerUserId, user, 'channel')
    const session = createChannelSessionRepo(this.deps.db).findById(sessionId)
    if (!session || session.channelId !== channelId) throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
    if (session.instanceKind !== 'manual') throw new AppError(409, 'SESSION_MANAGED', '仅手工会话可重建运行实例')
    if (session.status !== 'active') throw new AppError(409, 'SESSION_NOT_ACTIVE', '会话已关闭，不能重建运行实例')
    const map = parseJson<Record<string, string>>(session.memberMapJson, {})
    if (!Object.values(map).includes(agentId)) {
      throw new AppError(404, 'NOT_FOUND', `会话 runtime 不存在: ${agentId}`)
    }
    const member = this.deps.repos.channelAgents.findById(agentId)
    if (!member || member.role !== 'worker') {
      throw new AppError(409, 'RUNTIME_REBUILD_LEAD_UNSUPPORTED', 'lead 运行实例不支持手动重建（调度器持有其引用）；请等待自然重装配')
    }
    return { queued: this.requestRuntimeRebuild(channelId, agentId, 'manual'), effectiveAt: 'next_turn' }
  }

  /**
   * 会话绑定范围（product/line/recipes）：创建快照是基线，覆盖行让运行期可改。
   * 写入后在下一回合由 manager 的 scope fingerprint 检测并热切换。
   */
  getSessionBinding(channelId: string, sessionId: string, user: ActingUser): SessionBindingView {
    this.getChannelForUser(channelId, user.id)
    return createSessionBindingService(this.deps.db).get(channelId, sessionId)
  }

  async updateSessionBinding(
    channelId: string,
    sessionId: string,
    input: { expectedRevision: number, reset?: boolean, productId?: string, recipeIds?: string[] },
    user: ActingUser & { name?: string },
  ): Promise<SessionBindingView> {
    const channel = this.getChannelForUser(channelId, user.id)
    this.requireWritable(channel.ownerUserId, user, 'channel')
    return createSessionBindingService(this.deps.db).update({
      channelId,
      sessionId,
      expectedRevision: input.expectedRevision,
      reset: input.reset,
      productId: input.productId,
      recipeIds: input.recipeIds,
      actor: { id: user.id, role: user.role, name: user.name },
    })
  }

  channelModeForAgent(agentId: string): import('../../db/database/rows').ChannelMode {
    try {
      const agent = this.deps.repos.channelAgents.findById(agentId)
      if (!agent) return 'generic'
      const sessions = createChannelSessionRepo(this.deps.db).listByChannel(agent.channelId)
      const matches = sessions.filter((session) => {
        if (session.status !== 'active' || (session.instanceKind !== 'manual' && session.instanceKind !== 'task')) return false
        const memberMap = parseJson<Record<string, string>>(session.memberMapJson, {})
        return memberMap !== null && typeof memberMap === 'object' && !Array.isArray(memberMap) && Object.values(memberMap).includes(agentId)
      })
      if (matches.length > 1) return 'generic'
      if (matches.length === 1) {
        const session = matches[0]!
        if (session.channelMode !== 'production_line_integrated') return 'generic'
        return resolveTrustedSessionBinding(this.deps.db, session, { recipeLookup: id => getDcwRecipeRepo().byId(id) })?.channelMode ?? 'generic'
      }
      if (agent.name.includes(SESSION_MARKER) || agent.name.includes('·任务·')) return 'generic'
      return this.channelModeOf(agent.channelId)
    }
    catch {
      return 'generic'
    }
  }

  /** Trusted active Session scope for an exact clone membership; ambiguous/legacy is denied. */
  channelSessionScopeOfAgent(channelId: string, agentId: string): import('../../agents/host-tool-bridge').ChannelSessionExecutionScope | null {
    const session = activeSessionOfMember(createChannelSessionRepo(this.deps.db).listByChannel(channelId), agentId)
    if (!session) return null
    const trusted = resolveTrustedSessionBinding(this.deps.db, session, { recipeLookup: id => getDcwRecipeRepo().byId(id) })
    if (!trusted) return null
    return {
      sessionId: trusted.sessionId,
      productId: trusted.productId,
      lineId: trusted.lineId,
      bindingSnapshotHash: trusted.bindingSnapshotHash,
      bindingSnapshotRevision: trusted.bindingSnapshotRevision,
      recipes: trusted.recipes,
    }
  }

  /**
   * 会话身份(仅 id;不含工业授权):generic 会话无绑定快照、trustedSessionBindingIdentity
   * 返回 null,但记忆归属仍需要可信 sessionId。与 channelSessionScopeOfAgent 同源派生
   * (activeSessionOfMember 唯一命中才返回,歧义/legacy fail-closed),只暴露会话 id —— 不含
   * productId/lineId/recipes,不构成任何工业授权。
   */
  sessionIdOfAgent(channelId: string, agentId: string): string | null {
    return activeSessionOfMember(createChannelSessionRepo(this.deps.db).listByChannel(channelId), agentId)?.id ?? null
  }

  /**
   * 项目任务实例（plan 2026-11-07）：为工作项创建专属执行 Channel + 会话行。
   * 返回实例 Channel 与其 lead（root 任务 assignee）。幂等由调用方（项目派发）负责。
   */
  async createTaskInstance(input: Partial<ChannelAgentCreationSource> & TaskInstancePrefabOptions & {
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
    prefabSnapshotJson: string
    prefabSnapshotHash: string
  }> {
    const template = this.deps.repos.channels.findById(input.templateChannelId)
    if (!template) throw new AppError(404, 'NOT_FOUND', `模板 Channel 不存在: ${input.templateChannelId}`)
    this.requireWritable(template.ownerUserId, input.actor, 'channel')
    const result = await createTaskInstanceChannel(
      {
        channels: { findById: id => this.deps.repos.channels.findById(id) },
        channelAgents: this.deps.repos.channelAgents as unknown as TaskInstanceDeps['channelAgents'],
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
        prefabSnapshot: input.prefabSnapshot,
        pinPrefabSnapshot: input.pinPrefabSnapshot,
        createdByKind: input.createdByKind,
        createdById: input.createdById,
        createdVia: input.createdVia,
        createdReason: input.createdReason,
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
