/**
 * ChatProjectionService —— 群聊/成员/快照的**白名单 DTO 投影**(主计划 §13.1)。
 *
 * 问题:管理面对象(ChannelRow / ChannelAgentRow / AepSnapshot)包含 token、config、
 * 工作目录、内部 mailbox 载荷。普通成员一旦能读群聊/订阅 WS,就会顺带拿到这些字段。
 * 因此群聊 REST、历史、WS 快照与重放**必须**共用本模块产出的投影,
 * 不允许只靠前端隐藏字段。
 *
 * 禁止普通成员读取(投影后必然缺失):
 *  - Agent token(实例身份凭证)
 *  - Harness credentials / 完整 tool config
 *  - Channel 工作目录(workspace)
 *  - 私有 memory
 *  - 内部 mailbox / task payload(parts/metadata 原样)
 */
import type { ChannelRow, ChannelMemberRow, ChatMessageRow, ChannelAgentRow, UserNotificationRow } from '../db/database'
import { parseJson } from '../db/database'
import type { ChatMention } from '../db/chat-message.repo'
import type { AepNotification } from '../../../../shared/workshop-protocol'

/** 群成员投影(人类成员;不含任何凭据) */
export interface PublicChannelMemberDto {
  /** 全局用户 id(稳定 ID;不是本库遗留 users 表 id) */
  userId: string
  /** 展示名(服务端解析;解析失败为 null,前端回落到 id 前缀) */
  displayName: string | null
  /** 'owner' | 'member' */
  role: string
  /** 'active' | 'pending' | 'left' | 'removed' */
  status: string
  joinedAt: string
  leftAt: string | null
}

/** Agent 成员投影(群聊可见的 Agent 名册;**不含 token/config**) */
export interface PublicAgentMemberDto {
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  enabled: number
  /** 运行态(idle|busy|stopped);未装配时为 idle */
  state: 'idle' | 'busy' | 'stopped'
}

/** Channel 投影(群聊可见的设置子集;不含 workspace / llm 配置细节) */
export interface PublicChannelDto {
  id: string
  name: string
  description: string
  visibility: string
  joinPolicy: string
  approvalPolicy: string
  chatEnabled: number
  version: number
  /** 遗留无归属 Channel(不允许群聊操作) */
  legacy: boolean
}

/** 群聊消息投影(mentions 反序列化;replyTo/requester 关联链完整保留) */
export interface ChatMessageDto {
  id: string
  channelId: string
  senderType: 'user' | 'agent' | 'system'
  senderId: string
  senderName: string
  text: string
  mentions: ChatMention[]
  replyToId: string | null
  requesterUserId: string | null
  sourceChatMessageId: string | null
  clientMessageId: string
  createdAt: string
}

/** WS channel.snapshot 的群聊侧投影(与管理面 snapshot 分离) */
export interface ChatSnapshotDto {
  channel: PublicChannelDto
  members: PublicChannelMemberDto[]
  /** 群聊时间线最近 N 条(升序;新→旧由前端决定呈现) */
  chatMessages: ChatMessageDto[]
  /** 成员是否具备管理权(决定是否附带 agents/tasks 管理面) */
  canManage: boolean
  /**
   * 仅 canManage=true 时附带:管理面 agents 视图。
   * 非管理者**不出现该键**(而不是空数组)——避免下游误以为"没有成员"。
   */
  agents?: PublicAgentMemberDto[]
}

export function projectChannel(channel: ChannelRow): PublicChannelDto {
  return {
    id: channel.id,
    name: channel.name,
    description: channel.description,
    visibility: channel.visibility,
    joinPolicy: channel.joinPolicy,
    approvalPolicy: channel.approvalPolicy,
    chatEnabled: channel.chatEnabled,
    version: channel.version,
    legacy: channel.ownerUserId === null,
  }
}

export function projectChannelMember(row: ChannelMemberRow, displayName: string | null): PublicChannelMemberDto {
  return {
    userId: row.userId,
    displayName,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
  }
}

/**
 * `user_notifications` 行 → AEP `notification.created` 载荷。
 *
 * 单一事实源:`manager.notifyUser()` 与 `manager.publishNotification()` 原先各写一份
 * 逐字相同的 15 行字段映射,任一处漏改就会让"落库的通知"与"推送的通知"形状漂移
 * (前端按 eventId 去重,字段漂移会导致同一通知渲染成两种样子)。这里收敛为一处。
 */
export function projectNotification(row: UserNotificationRow): AepNotification {
  return {
    id: row.id,
    recipientUserId: row.recipientUserId,
    channelId: row.channelId,
    chatMessageId: row.chatMessageId,
    hitlKind: row.hitlKind,
    hitlId: row.hitlId,
    eventId: row.eventId,
    type: row.type as AepNotification['type'],
    title: row.title,
    body: row.body,
    payload: parseJson<Record<string, unknown>>(row.payloadJson, {}),
    createdAt: row.createdAt,
    readAt: row.readAt,
  }
}

/** Agent 成员投影:显式挑字段(禁止 spread,防新增敏感列时静默泄漏) */
export function projectAgentMember(
  row: Pick<ChannelAgentRow, 'id' | 'name' | 'role' | 'harness' | 'enabled'>,
  state: 'idle' | 'busy' | 'stopped' = 'idle',
): PublicAgentMemberDto {
  return {
    agentId: row.id,
    name: row.name,
    role: row.role as 'lead' | 'worker',
    harness: row.harness,
    enabled: row.enabled,
    state,
  }
}

export function projectChatMessage(row: ChatMessageRow): ChatMessageDto {
  return {
    id: row.id,
    channelId: row.channelId,
    senderType: row.senderType as ChatMessageDto['senderType'],
    senderId: row.senderId,
    senderName: row.senderName,
    text: row.text,
    mentions: parseJson<ChatMention[]>(row.mentionsJson, []),
    replyToId: row.replyToId,
    requesterUserId: row.requesterUserId,
    sourceChatMessageId: row.sourceChatMessageId,
    clientMessageId: row.clientMessageId,
    createdAt: row.createdAt,
  }
}

/**
 * 群聊快照投影。
 * @param displayNameOf userId → 展示名(调用方注入解析器,避免本模块依赖用户仓储)
 * @param agentStates    agentId → 运行态(可选)
 * @param manageAgents   仅当调用者具备管理权时传入;非 null 才附 `agents` 键
 */
export function projectChatSnapshot(input: {
  channel: ChannelRow
  members: ChannelMemberRow[]
  messages: ChatMessageRow[]
  displayNameOf: (userId: string) => string | null
  manageAgents?: Array<Pick<ChannelAgentRow, 'id' | 'name' | 'role' | 'harness' | 'enabled'>> | null
  agentStates?: Record<string, 'idle' | 'busy' | 'stopped'>
}): ChatSnapshotDto {
  const dto: ChatSnapshotDto = {
    channel: projectChannel(input.channel),
    members: input.members.map(m => projectChannelMember(m, input.displayNameOf(m.userId))),
    chatMessages: input.messages.map(projectChatMessage),
    canManage: input.manageAgents != null,
  }
  if (input.manageAgents != null) {
    dto.agents = input.manageAgents.map(a => projectAgentMember(a, input.agentStates?.[a.id] ?? 'idle'))
  }
  return dto
}

/**
 * 管理面 AEP snapshot 的**降级投影**:非管理者订阅 WS 时,
 * agents 只保留白名单字段(原实现直出 name/role/harness/enabled/config),
 * messages(内部 mailbox)整体剔除,tasks 仅保留计数不保留 payload。
 *
 * 返回 `null` 表示调用者有权获取完整管理面快照。
 */
export function projectManagementSnapshotForMember(snapshot: Record<string, unknown>): Record<string, unknown> {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents as Array<Record<string, unknown>> : []
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  return {
    channelId: snapshot.channelId,
    channel: snapshot.channel
      ? projectChannel(snapshot.channel as unknown as ChannelRow)
      : null,
    agents: agents.map(a => ({
      agentId: a.agentId,
      name: a.name,
      role: a.role,
      harness: a.harness,
      enabled: a.enabled,
      state: a.state ?? 'idle',
      currentTaskId: a.currentTaskId ?? null,
      currentTaskTitle: a.currentTaskTitle ?? null,
      currentTaskProgress: a.currentTaskProgress ?? null,
      queued: a.queued ?? 0,
      completed: a.completed ?? 0,
      // config 被剔除(可能含 credentials / tool 配置)
    })),
    // 内部 mailbox 载荷整体不出现在成员视图
    messages: [],
    // 任务只给计数与状态摘要,不给 artifacts/history payload
    tasks: tasks.map((t) => {
      const task = t as Record<string, unknown>
      return {
        id: task.id,
        title: task.title,
        state: task.state,
        progress: task.progress,
        assigneeId: task.assigneeId,
        parentId: task.parentId ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }
    }),
    queue: snapshot.queue ?? [],
  }
}
