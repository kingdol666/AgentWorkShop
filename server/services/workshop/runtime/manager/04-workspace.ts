/**
 * ManagerWorkspace —— AgentWorkspace 能力面与 lead 根任务登记
 * (分层 5/19,承 ManagerRuntimeObserve)
 */
import { ManagerRuntimeObserve } from './03-runtime-observe'
import type { AgentInfo, AgentWorkspace } from '../../agents/agent-interface'
import type { Part } from '../../types/a2a'
import type { WorkspaceTask } from '../../types/task'
import type { AgentMemory } from '../memory'
import { AppError } from '../../../../utils/errors'
import { workshopSettings } from '../../settings'

export abstract class ManagerWorkspace extends ManagerRuntimeObserve {
  /** Agent 自主作业能力面(绑定本实例身份与 channel,委托 manager 作业方法) */
  protected buildWorkspace(agent: AgentInfo, memory: AgentMemory): AgentWorkspace {
    const channelId = agent.channelId
    return {
      listAgents: () => this.listChannelAgents(channelId),
      dispatchTask: input => this.dispatchTask(channelId, agent.id, input),
      listTasks: () => this.listTasks(channelId, agent.id),
      getTask: taskId => this.getTask(channelId, agent.id, taskId),
      reportTask: input => this.reportTask(channelId, agent.id, input),
      completeTask: (taskId, artifacts) => this.completeTask(channelId, agent.id, { taskId, artifacts }),
      cancelTask: taskId => this.cancelTask(channelId, agent.id, { taskId }),
      myQueue: () => this.myQueue(channelId, agent.id),
      queueOverview: () => this.queueOverview(channelId, agent.id),
      updateTask: (taskId, patch) => this.updateTask(channelId, agent.id, taskId, patch),
      reassignTask: (taskId, toAgentId) => this.reassignTask(channelId, agent.id, taskId, toAgentId),
      sendMessage: input => this.sendA2A(channelId, agent.id, input),
      sendCrossChannelMessage: input => this.sendCrossChannelMessage(channelId, agent.id, input),
      listOtherTeams: () => this.listOtherTeamsOverview(channelId, agent.id),
      searchOtherTeamsMemory: input => this.recallOtherTeamsMemory(channelId, agent.id, input),
      refuseTask: (taskId, reason) => this.refuseTask(channelId, agent.id, taskId, reason),
      pollMailbox: limit => this.pollMailbox(channelId, agent.id, limit),
      waitMailbox: (limit, waitMs) => this.waitMailbox(channelId, agent.id, limit ?? 10, waitMs ?? 0),
      ackMailbox: ids => Promise.resolve(this.ackMailbox(channelId, agent.id, ids)),
      listMail: opts => this.listChannelMail(channelId, agent.id, opts),
      subscribe: input => this.subscribe(channelId, agent.id, input),
      // 记忆按需抓取/主动沉淀(成员校验 + 委托本实例 AgentMemory;shared 写入即 Channel 公共域)
      recallMemory: async (input) => {
        this.requireMember(channelId, agent.id)
        return memory.recallRows(input.query, { scope: input.scope, limit: input.limit })
      },
      saveMemory: async (input) => {
        this.requireMember(channelId, agent.id)
        const saved = await memory.save(input)
        this.buses.get(channelId)?.notifyMemory({ agentId: agent.id, scope: input.scope, title: input.title, dedupKey: saved.dedupKey })
        return saved
      },
      // 会话压缩摘要入库(harvest 桥):omp 压缩产出 → 本成员 episodic-session 记忆
      recordSessionMemory: async (input) => {
        const saved = await memory.recordSessionCompaction(input)
        this.buses.get(channelId)?.notifyMemory({ agentId: agent.id, scope: 'private', title: `会话压缩摘要(${input.summary.length}字)`, dedupKey: saved.dedupKey })
      },
      // 团队成员管理(仅 lead;manager 内二次校验角色,工具面与决策面共用)
      createTeamMember: input => this.createTeamMember(channelId, agent.id, input),
      updateTeamMember: (agentId, patch) => this.updateTeamMember(channelId, agent.id, agentId, patch),
      removeTeamMember: (agentId, reason) => this.removeTeamMember(channelId, agent.id, agentId, reason),
      // 群聊/自由请求 → 可追踪根任务(仅 lead;见 AgentWorkspace.submitTask 注释)
      submitTask: input => this.submitLeadRootTask(channelId, agent.id, input),
    }
  }

  /**
   * Lead 把一次人类请求升级为**可追踪的根任务**(归属 Lead 自己)。
   *
   * 与 `submitChannelTask` 的差别(为什么不能复用):
   *  - `submitChannelTask` 是**人类入口**:router 层已鉴权,且会向 assignee 投递 assign 消息、
   *    做重复标题拦截;它的 assignee 缺省是 lead,但也可被显式指定为 worker(人类直发)。
   *  - 本方法是**Agent 入口**:调用方必须是本 channel 的 lead,任务归属 lead 自己,
   *    且**不投递 assign 消息** —— lead 此刻就在回合里,自我唤醒只会造成一次空转回合;
   *    分解/作答由调度器随后按"lead 名下未规划根任务"触发 supervise 继续(见
   *    SchedulerLoop.shouldSupervise 的 hasUnplannedLeadRoot)。
   *
   * 幂等:同标题未终态根任务已存在时直接返回既有任务(Lead 重试/重复思考不产生重复作业)。
   */
  protected async submitLeadRootTask(
    channelId: string,
    callerAgentId: string,
    input: { title: string, description?: string, parts?: Part[], sourceChatMessageId?: string, sourceChatDeliveryId?: string },
  ): Promise<WorkspaceTask> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'ROLE_FORBIDDEN', '仅 lead 可将请求登记为根任务(submit_task)')
    }
    const title = String(input.title ?? '').trim()
    if (!title) throw new AppError(400, 'BAD_REQUEST', 'submit_task 需要非空 title')
    const roots = this.getTaskEngine().list(channelId).filter(t => !t.parentId)
    // 持久化来源身份是强幂等键:同一条群聊消息即使 Lead 改标题也只能有一个 root。
    const existingBySource = input.sourceChatMessageId
      ? roots.find(t => t.sourceChatMessageId === input.sourceChatMessageId)
      : undefined
    if (existingBySource) return existingBySource
    // 无来源 ID 的旧入口保留标题兜底,但只拦截在途任务。
    const existing = roots.find(t =>
      !input.sourceChatMessageId
      && t.title === title
      && t.state !== 'COMPLETED' && t.state !== 'FAILED' && t.state !== 'CANCELED')
    if (existing) return existing
    const deadlineAt = /^\[mode:(goal|loop|pipeline)\]/.test(input.description ?? '')
      ? undefined
      : new Date(Date.now() + Math.max(10_000, Number(workshopSettings().root_timeout_ms ?? 900_000))).toISOString()
    const task = this.getTaskEngine().create({
      channelId,
      creatorId: callerAgentId,
      assigneeId: callerAgentId,
      title,
      description: input.description,
      parts: input.parts,
      sourceChatMessageId: input.sourceChatMessageId,
      sourceChatDeliveryId: input.sourceChatDeliveryId,
      deadlineAt,
    })
    // 唤起调度:下一 tick 即按"lead 名下未规划根任务"请 lead 继续(分解或直接作答)
    this.ensureChannelRuntime(channelId).wakeScheduler()
    return task
  }

  // ===== 用户面(用户级隔离;管理 API 凭证 = 用户 token)=====
}
