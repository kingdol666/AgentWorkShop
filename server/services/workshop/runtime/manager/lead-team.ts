/**
 * ManagerLeadTeam —— lead 自主团队管理面(扩容/调参/裁撤)
 * (拆分层,承 ManagerAdminAgents)
 */
import { ManagerAdminAgents } from './admin-agents'
import type { AgentInfo } from '../../agents/agent-interface'
import { AppError } from '../../../../utils/errors'
import { KNOWN_HARNESSES, rowToTask } from './helpers'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { assertHarnessUsable } from '../../agents/harness-availability'
import { workshopSettings } from '../../settings'

export abstract class ManagerLeadTeam extends ManagerAdminAgents {
  /** lead 在本 channel 新建团队成员(worker):按需落模板(owner=channel 属主)并克隆为独立实例 */
  async createTeamMember(
    channelId: string,
    callerAgentId: string,
    input: { name: string, harness?: string, config?: Record<string, unknown>, templateId?: string, reason?: string },
  ): Promise<AgentInfo> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可管理团队成员')
    const channel = this.requireChannelRow(channelId)
    const name = input.name.trim()
    if (!name) throw new AppError(400, 'BAD_REQUEST', '成员名不能为空')
    const workerCount = this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.role === 'worker').length
    const workerLimit = Math.max(1, Number(workshopSettings().max_lead_created_workers ?? 8))
    if (workerCount >= workerLimit) {
      throw new AppError(409, 'TEAM_WORKER_LIMIT',
        `Channel worker 名册已达到上限 ${workerCount}/${workerLimit}(禁用成员也计数)。请复用现有成员或先由用户调整名册。`)
    }
    let templateId = input.templateId
    if (templateId) {
      if (!this.deps.repos.agents.findById(templateId)) {
        throw new AppError(404, 'NOT_FOUND', `Agent 模板不存在: ${templateId}`)
      }
    }
    else {
      const harness = input.harness ?? 'omp'
      if (!KNOWN_HARNESSES.has(harness)) {
        throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${harness}(可选 ${[...KNOWN_HARNESSES].join('/')})`)
      }
      // 先校验引擎可用再落模板,防断言失败遗留孤儿模板行
      assertHarnessUsable(harness, input.config)
      const tpl = this.deps.repos.agents.create({
        name,
        harness,
        config: input.config,
        ownerUserId: channel.ownerUserId ?? null,
      })
      templateId = tpl.id
    }
    // 新成员立即装配:lead 建员即进入 channel 运行时(前端/调度立即可见,
    // 无需等首次任务投递的懒加载;DB 已由 addAgentToChannel 同步落库)
    const member = await this.addAgentToChannel({
      channelId,
      agentId: templateId,
      role: 'worker',
      by: `lead:${callerAgentId}`,
      reason: input.reason,
    })
    this.ensureAgentRuntime(channelId, member.id)
    return member
  }

  /** lead 更新团队成员(改名/改配置/启停;不能改自己);变更后卸载运行时,下次消费按新配置重载 */
  async updateTeamMember(
    channelId: string,
    callerAgentId: string,
    agentId: string,
    patch: { name?: string, config?: Record<string, unknown>, enabled?: number, reason?: string },
  ): Promise<AgentInfo> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可管理团队成员')
    if (agentId === callerAgentId) {
      throw new AppError(400, 'BAD_REQUEST', 'lead 不能在执行中更新自己(避免自毁调度循环)')
    }
    const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!target) throw new AppError(404, 'NOT_FOUND', `团队成员不存在: ${agentId}`)
    return this.updateChannelAgent(agentId, patch, { channelId, by: `lead:${callerAgentId}`, reason: patch.reason })
  }

  /**
   * lead 移除团队成员(worker;不能移除自己)。
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
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可管理团队成员')
    if (agentId === callerAgentId) {
      throw new AppError(400, 'BAD_REQUEST', 'lead 不能移除自己(移除 lead 请用 REST 删除)')
    }
    const target = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!target) throw new AppError(404, 'NOT_FOUND', `团队成员不存在: ${agentId}`)

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
    // lead 现场创建的一次性模板:无任何 channel 实例、未被编组引用 → 连模板一并删除
    // (数据库信息彻底清理;有外部引用则保留模板,仅删实例行)
    if (target.templateId) {
      const instances = this.deps.repos.channelAgents.listByTemplate(target.templateId)
      const teamRefs = this.deps.repos.teamMembers.listByTemplate(target.templateId)
      if (instances.length === 0 && teamRefs.length === 0) {
        this.deps.repos.agents.remove(target.templateId)
      }
    }
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
