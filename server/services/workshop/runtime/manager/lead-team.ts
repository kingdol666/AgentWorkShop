/**
 * ManagerLeadTeam —— lead 自主团队管理面(扩容/调参/裁撤)
 * (拆分层,承 ManagerAdminAgents)
 */
import { ManagerAdminAgents } from './admin-agents'
import type { AgentInfo, CreateTeamMemberInput, TeamMemberView, UpdateTeamMemberPatch } from '../../agents/agent-interface'
import { AppError } from '../../../../utils/errors'
import { instanceToAgentInfo, KNOWN_HARNESSES, log, rowToTask } from './helpers'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { workshopSettings } from '../../settings'
import { createAgentPrefabService, parseAgentPrefabBinding } from '../../agent-prefabs/service'
import { prefabBlockedReason, resolveRuntimeForAgent } from '../../agent-prefabs/runtime'
import type { ChannelAgentRow, ChannelRow } from '../../db/database/rows'
import { withTransaction } from '../../db/transaction'
import { checkToolAgainstScope } from '../permission-scope'
import { createChannelSessionRepo } from '../../db/channel-session.repo'
import { isUnclosedSessionClone } from '../../agents/session-clone'

function isCurrentLead(channel: ChannelRow, caller: ChannelAgentRow): boolean {
  return channel.enabled === 1 && channel.leadAgentId === caller.id
    && caller.role === 'lead' && caller.enabled === 1 && caller.agentKind === 'channel_agent'
}

function isCreatedWorker(member: ChannelAgentRow, leadId: string): boolean {
  return member.role === 'worker' && member.agentKind === 'channel_agent'
    && member.createdByKind === 'leader' && member.createdById === leadId
}

export abstract class ManagerLeadTeam extends ManagerAdminAgents {
  private requireTeamLead(channelId: string, callerAgentId: string, tool: string): ChannelRow {
    const caller = this.requireMember(channelId, callerAgentId)
    const channel = this.requireChannelRow(channelId)
    if (!isCurrentLead(channel, caller)) throw new AppError(403, 'SCOPE_VIOLATION', '仅当前启用的频道 lead 可管理团队成员')
    const verdict = checkToolAgainstScope(this.activeScopeOf(callerAgentId), tool)
    if (!verdict.allowed) throw new AppError(403, verdict.reason, verdict.message)
    return channel
  }

  private requireManagedWorker(channelId: string, callerAgentId: string, agentId: string): ChannelAgentRow {
    const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!target) throw new AppError(404, 'NOT_FOUND', `团队成员不存在: ${agentId}`)
    if (!isCreatedWorker(target, callerAgentId)) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅可管理自己创建的本频道 worker')
    }
    this.assertRemovableChannelAgent(target)
    return target
  }

  private buildTeamBindingJson(channel: ChannelRow, raw: unknown): string {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'prefab 必须是已发布版本选择器')
    }
    const { prefabId, revision, slotValues } = raw as Record<string, unknown>
    if (Object.keys(raw).some(key => !['prefabId', 'revision', 'slotValues'].includes(key))
      || typeof prefabId !== 'string' || !prefabId.trim() || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
      || (slotValues !== undefined && (!slotValues || typeof slotValues !== 'object' || Array.isArray(slotValues)))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'prefab 仅接受 prefabId、正整数 revision 和可选的 slotValues 对象')
    }
    return JSON.stringify(createAgentPrefabService(this.deps.db).buildBinding({
      kind: 'channel-lead', channelOwnerUserId: channel.ownerUserId,
    }, prefabId.trim(), revision, slotValues))
  }

  async listTeamMembers(channelId: string, callerAgentId: string): Promise<TeamMemberView[]> {
    const caller = this.requireMember(channelId, callerAgentId)
    const channel = this.requireChannelRow(channelId)
    const canManage = isCurrentLead(channel, caller) && checkToolAgainstScope(this.activeScopeOf(callerAgentId), 'update_team_agent').allowed
    const sessions = canManage ? createChannelSessionRepo(this.deps.db).listByChannel(channelId) : []
    return this.deps.repos.channelAgents.listByChannel(channelId).map((row) => {
      const manageable = canManage && isCreatedWorker(row, callerAgentId) && !isUnclosedSessionClone(sessions, row.id)
      let prefabBinding: TeamMemberView['prefabBinding'] = null
      try {
        const binding = parseAgentPrefabBinding(row.prefabBindingJson)
        if (binding) prefabBinding = { prefabId: binding.prefabId, revision: binding.revision, contentHash: binding.contentHash }
      }
      catch { /* 损坏的绑定由执行面拒绝，不应导致全员名单不可读。 */ }
      return { id: row.id, name: row.name, role: row.role as AgentInfo['role'], harness: row.harness, enabled: row.enabled, prefabBinding, manageable, protected: !manageable }
    })
  }

  /** 成员、来源和 prefab binding 同一事务持久化；运行时副作用仅在提交后发生。 */
  async createTeamMember(channelId: string, callerAgentId: string, input: CreateTeamMemberInput): Promise<AgentInfo> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new AppError(400, 'BAD_REQUEST', '成员名不能为空')
    const by = `lead:${callerAgentId}`
    const workerLimit = Math.max(1, Number(workshopSettings().max_lead_created_workers ?? 8))
    const inst = withTransaction(this.deps.db, () => {
      const channel = this.requireTeamLead(channelId, callerAgentId, 'create_team_agent')
      const workerCount = this.deps.repos.channelAgents.listByChannel(channelId).filter(m => m.role === 'worker').length
      if (workerCount >= workerLimit) {
        throw new AppError(409, 'TEAM_WORKER_LIMIT',
          `Channel worker 名册已达到上限 ${workerCount}/${workerLimit}(禁用成员也计数)。请复用现有成员或先由用户调整名册。`)
      }
      const prefabBindingJson = input.prefab === undefined ? undefined : this.buildTeamBindingJson(channel, input.prefab)
      let templateId = input.templateId
      if (templateId) {
        const tpl = this.deps.repos.agents.findById(templateId)
        if (!tpl || (tpl.visibility !== 'public' && (!channel.ownerUserId || tpl.ownerUserId !== channel.ownerUserId))) {
          throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在或不可用: ${templateId}`)
        }
      }
      else {
        const harness = input.harness ?? 'omp'
        if (!KNOWN_HARNESSES.has(harness)) {
          throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${harness}(可选 ${[...KNOWN_HARNESSES].join('/')})`)
        }
        templateId = this.deps.repos.agents.create({ name, harness, config: input.config, ownerUserId: channel.ownerUserId }).id
      }
      const member = this.insertChannelAgent({
        channelId,
        agentId: templateId,
        role: 'worker',
        actor: { role: 'agent', id: callerAgentId },
        createdByKind: 'leader',
        createdById: callerAgentId,
        createdVia: 'lead_team',
        createdReason: input.reason,
        prefabBindingJson,
      })
      if (prefabBindingJson) {
        const prefabRuntime = resolveRuntimeForAgent(this.deps.db, member.id)
        const blocked = prefabRuntime?.binding && prefabBlockedReason(prefabRuntime.resolution)
        if (!prefabRuntime?.binding || blocked) {
          throw new AppError(409, 'PREFAB_REQUIRED_CAPABILITY_MISSING', blocked || 'AgentPrefab 无法装配')
        }
      }
      return member
    })
    this.notifyChannelAgentAdded(inst, { by, reason: input.reason })
    try {
      this.ensureAgentRuntime(channelId, inst.id)
    }
    catch (err) {
      // 创建已经提交；装配可在下一次使用时重试，不能把已加入的成员报告为创建失败。
      log.warn(`[workshop] 新成员 ${inst.id} 暂未装配:`, err)
    }
    return instanceToAgentInfo(inst)
  }

  async updateTeamMember(channelId: string, callerAgentId: string, agentId: string, patch: UpdateTeamMemberPatch): Promise<AgentInfo> {
    const channel = this.requireTeamLead(channelId, callerAgentId, 'update_team_agent')
    this.requireManagedWorker(channelId, callerAgentId, agentId)
    const prefabBindingJson = patch.prefab === undefined
      ? undefined
      : patch.prefab === null
        ? ''
        : this.buildTeamBindingJson(channel, patch.prefab)
    // Explicitly pick instance fields. In particular, no caller-supplied serialized binding or source can pass through.
    return this.updateChannelAgent(agentId, { name: patch.name, config: patch.config, enabled: patch.enabled, prefabBindingJson }, {
      channelId, by: `lead:${callerAgentId}`, reason: patch.reason, actor: { role: 'agent', id: callerAgentId },
    })
  }

  /**
   * lead 只能移除自己创建的本频道 worker；不触碰全局模板。
   * 孤儿任务回收(成员移除后其任务不能悬死):
   *  - SUBMITTED/ASSIGNED(排队中)→ 重派给剩余队列最短的 worker;无接收者 → 取消
   *  - WORKING/WAITING(执行中)→ 中止运行时并置 FAILED,交调度循环按重试策略重派
   */
  async removeTeamMember(
    channelId: string,
    callerAgentId: string,
    agentId: string,
    reason?: string,
  ): Promise<{ recycledTasks: string[] }> {
    this.requireTeamLead(channelId, callerAgentId, 'remove_team_agent')
    this.requireManagedWorker(channelId, callerAgentId, agentId)

    const recycledTasks: string[] = []
    const orphans = this.deps.repos.tasks
      .listByChannelAssignee(channelId, agentId)
      .map(rowToTask)
      .filter(t => !TERMINAL_TASK_STATES[t.state])
    for (const task of orphans) {
      if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') {
        const receiver = this.pickReceiverWorker(channelId, agentId)
        if (receiver) {
          this.getTaskEngine().reassign(task.id, receiver)
          this.wakeAgent(channelId, receiver)
        }
        else {
          this.getTaskEngine().cancel(task.id, callerAgentId)
        }
      }
      else {
        // WORKING/WAITING:先中止在跑回合,再走 FAILED(调度循环 retry/reassign 兜底)
        this.runtimeOf(channelId, agentId)?.abortCurrent()
        if (task.state === 'WAITING') {
          this.getTaskEngine().transition(task.id, 'WORKING', callerAgentId)
        }
        this.getTaskEngine().transition(task.id, 'FAILED', callerAgentId)
      }
      recycledTasks.push(task.id)
    }

    await this.removeAgentFromChannel(channelId, agentId, { by: `lead:${callerAgentId}`, reason })
    return { recycledTasks }
  }

  /** 剩余可用 worker 里选队列最短者(成员移除重派接收者) */
  protected pickReceiverWorker(channelId: string, excludeAgentId: string): string | null {
    const candidates = this.deps.repos.channelAgents
      .listByChannel(channelId)
      .filter(m => m.enabled === 1 && m.role === 'worker' && m.id !== excludeAgentId)
    let best: string | null = null
    let bestLen = Number.POSITIVE_INFINITY
    for (const m of candidates) {
      const len = this.getTaskEngine().queueViewOf(channelId, m.id).queued.length
      if (len < bestLen) {
        best = m.id
        bestLen = len
      }
    }
    return best
  }

  // ===== AgentTeam 管理面(模板编组 + 批量部署;v10 可见性隔离) =====
}
