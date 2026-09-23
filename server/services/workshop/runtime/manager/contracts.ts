/**
 * ManagerContracts —— **跨层能力契约**。
 *
 * 原类是一个整体,方法之间可以互相调用;拆成 19 个分层文件后,
 * 实测有 42 个方法被"更早的层"调用(共 378 条内部调用中的一部分)。
 * 与其把层序排成拓扑序打乱职责,不如把这类跨层调用显式声明为抽象契约:
 * 谁需要就调用,由实现它的那一层提供具体实现(TS 编译期校验签名一致)。
 *
 * 契约成员(按需要顺序列出):
 *   ackMailbox  → 由 host-tools.ts 实现
 *   agentReplyToChat  → 由 chat-reply.ts 实现
 *   auditChat  → 由 notifications.ts 实现
 *   buildBus  → 由 bus.ts 实现
 *   buildWorkspace  → 由 workspace.ts 实现
 *   cancelTask  → 由 tasks.ts 实现
 *   channelWorkspace  → 由 admin-channel.ts 实现
 *   chatPromptText  → 由 chat-reply.ts 实现
 *   completeTask  → 由 tasks.ts 实现
 *   createTeamMember  → 由 lead-team.ts 实现
 *   dispatchTask  → 由 tasks.ts 实现
 *   ensureAgentRuntime  → 由 runtime-wiring.ts 实现
 *   getTask  → 由 tasks.ts 实现
 *   listChannelAgents  → 由 admin-agents.ts 实现
 *   listChannelMail  → 由 host-tools.ts 实现
 *   listOtherTeamsOverview  → 由 a2a.ts 实现
 *   listTasks  → 由 tasks.ts 实现
 *   myQueue  → 由 tasks.ts 实现
 *   notificationRepo  → 由 access.ts 实现
 *   outboxRepo  → 由 access.ts 实现
 *   pollMailbox  → 由 host-tools.ts 实现
 *   publishChatDelivery  → 由 chat-reply.ts 实现
 *   publishChatMessage  → 由 chat-reply.ts 实现
 *   publishNotification  → 由 notifications.ts 实现
 *   queueOverview  → 由 tasks.ts 实现
 *   reassignTask  → 由 tasks.ts 实现
 *   recallOtherTeamsMemory  → 由 a2a.ts 实现
 *   refuseTask  → 由 tasks.ts 实现
 *   removeTeamMember  → 由 lead-team.ts 实现
 *   reportTask  → 由 tasks.ts 实现
 *   requireMember  → 由 internal.ts 实现
 *   requireTaskInScope  → 由 internal.ts 实现
 *   resolveMemberRef  → 由 internal.ts 实现
 *   route  → 由 internal.ts 实现
 *   sendA2A  → 由 a2a.ts 实现
 *   sendCrossChannelMessage  → 由 a2a.ts 实现
 *   submitChannelTask  → 由 tasks.ts 实现
 *   subscribe  → 由 host-tools.ts 实现
 *   updateTask  → 由 tasks.ts 实现
 *   updateTeamMember  → 由 lead-team.ts 实现
 *   waitMailbox  → 由 host-tools.ts 实现
 *   wakeAgent  → 由 internal.ts 实现
 */
import type { A2AArtifact, A2AMessage, ChannelMail, Part } from '../../types/a2a'
import type { AgentInfo, AgentWorkspace, ExecutionMode } from '../../agents/agent-interface'
import type { AgentStatusView, AgentTaskQueueView, WorkspaceTask } from '../../types/task'
import type { ChannelAgentRow } from '../../db/database'
import type { ChannelBus, AgentRuntime } from '../agent-runtime'
import type { ChatMessageDto } from '../chat-projection'
import type { ModeConfig } from '../execution-mode'
import type { NotificationRepo } from '../../db/notification.repo'
import type { OutboxRepo } from '../../db/outbox.repo'
import type { AgentMemory } from '../memory'
import type { ChannelRuntime } from '../channel-runtime'

export abstract class ManagerContracts {
  abstract ackMailbox(channelId: string, callerAgentId: string, messageIds: string[]): void
  abstract agentReplyToChat(input: {
    channelId: string
    agentId: string
    agentName: string
    text: string
    sourceChatMessageId?: string
    requesterUserId?: string
    inReplyTo?: string
  }): ChatMessageDto | null
  protected abstract auditChat(action: string, channelId: string, actor: string, detail: Record<string, unknown>): void
  protected abstract buildBus(cr: ChannelRuntime): ChannelBus
  protected abstract buildWorkspace(agent: AgentInfo, memory: AgentMemory): AgentWorkspace
  abstract cancelTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string },
  ): Promise<WorkspaceTask>
  protected abstract channelWorkspace(channelId: string): string
  protected abstract chatPromptText(requesterName: string, text: string): string
  abstract completeTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string, artifacts?: A2AArtifact[] },
  ): Promise<WorkspaceTask>
  abstract createTeamMember(
    channelId: string,
    callerAgentId: string,
    input: { name: string, harness?: string, config?: Record<string, unknown>, templateId?: string, reason?: string },
  ): Promise<AgentInfo>
  abstract dispatchTask(
    channelId: string,
    callerAgentId: string,
    input: {
      parentTaskId?: string
      assigneeId: string
      title: string
      description?: string
      parts?: Part[]
      routeReason?: string
    },
  ): Promise<WorkspaceTask>
  protected abstract ensureAgentRuntime(channelId: string, agentId: string): AgentRuntime | undefined
  abstract getTask(channelId: string, callerAgentId: string, taskId: string): Promise<WorkspaceTask>
  abstract listChannelAgents(channelId: string): Promise<AgentInfo[]>
  abstract listChannelMail(
    channelId: string,
    callerAgentId: string,
    opts?: { limit?: number, agentId?: string },
  ): Promise<ChannelMail[]>
  abstract listOtherTeamsOverview(channelId: string, agentId: string): Array<{
    channelId: string
    name: string
    description: string
    leadName: string | null
    /** 团队共享域知识量(实现体第 2661 行已产出;原声明漏写 → 与 AgentWorkspace.listOtherTeams 漂移) */
    sharedMemories: number
    activeTasks: Array<{ id: string, title: string, state: string }>
    recentCompleted: Array<{ title: string }>
  }>
  abstract listTasks(channelId: string, callerAgentId: string): Promise<WorkspaceTask[]>
  abstract myQueue(channelId: string, callerAgentId: string): Promise<AgentTaskQueueView>
  protected abstract get notificationRepo(): NotificationRepo
  protected abstract get outboxRepo(): OutboxRepo
  abstract pollMailbox(channelId: string, callerAgentId: string, limit?: number): Promise<A2AMessage[]>
  protected abstract publishChatDelivery(channelId: string, deliveryId: string): void
  protected abstract publishChatMessage(channelId: string, chatMessageId: string): void
  protected abstract publishNotification(eventId: string): void
  abstract queueOverview(channelId: string, callerAgentId: string): Promise<AgentStatusView[]>
  abstract reassignTask(
    channelId: string,
    callerAgentId: string,
    taskId: string,
    toAgentId: string,
  ): Promise<WorkspaceTask>
  abstract recallOtherTeamsMemory(channelId: string, agentId: string, input: { query: string, limit?: number }): Array<{
    channelId: string
    channelName: string
    title: string
    content: string
    importance: number
    createdAt: string
  }>
  abstract refuseTask(
    channelId: string,
    refuserId: string,
    taskId: string,
    reason: string,
  ): Promise<{ task: WorkspaceTask, notifiedTo: string | null }>
  abstract removeTeamMember(
    channelId: string,
    callerAgentId: string,
    agentId: string,
    reason?: string,
  ): Promise<{ recycledTasks: string[] }>
  abstract reportTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string },
  ): Promise<WorkspaceTask>
  protected abstract requireMember(channelId: string, agentId: string): ChannelAgentRow
  protected abstract requireTaskInScope(channelId: string, callerAgentId: string, taskId: string): WorkspaceTask
  protected abstract resolveMemberRef(channelId: string, ref: string): ChannelAgentRow
  protected abstract route(channelId: string, message: A2AMessage): string[]
  abstract sendA2A(
    channelId: string,
    callerAgentId: string,
    input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> },
  ): Promise<A2AMessage>
  abstract sendCrossChannelMessage(
    fromChannelId: string,
    fromAgentId: string,
    input: { toChannelId: string, parts: Part[], requireReply?: boolean, inReplyTo?: string },
  ): Promise<{ messageId: string, toChannelId: string, toChannelName: string, toLeadAgentId: string }>
  abstract submitChannelTask(input: {
    channelId: string
    title: string
    description?: string
    parts?: Part[]
    mode?: ExecutionMode
    modeConfig?: ModeConfig
    /** HITL 直发目标(缺省 lead);须为本 channel 启用成员 */
    assigneeId?: string
    /** 人类发送者显示名(时间线归属) */
    fromLabel?: string
  }): Promise<WorkspaceTask>
  abstract subscribe(channelId: string, callerAgentId: string, input: { agentIds?: string[] }): Promise<void>
  abstract updateTask(
    channelId: string,
    callerAgentId: string,
    taskId: string,
    patch: { title?: string, description?: string },
  ): Promise<WorkspaceTask>
  abstract updateTeamMember(
    channelId: string,
    callerAgentId: string,
    agentId: string,
    patch: { name?: string, config?: Record<string, unknown>, enabled?: number, reason?: string },
  ): Promise<AgentInfo>
  abstract waitMailbox(channelId: string, callerAgentId: string, limit: number, waitMs: number): Promise<A2AMessage[]>
  protected abstract wakeAgent(channelId: string, agentId: string): void
}
