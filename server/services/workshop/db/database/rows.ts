/**
 * 各表行类型(Row)定义
 * (由 server/services/workshop/db/database.ts 按职责拆出;内容逐行原文搬运)
 */

export interface ChannelRow {
  id: string
  name: string
  description: string
  /** channel 级作业场景 prompt(注入全部成员 harness;空串 = 无场景) */
  scenarioPrompt: string
  /** channel 级默认 LLM JSON({provider,model,effort};空串 = 用引擎默认) */
  llmJson: string
  leadAgentId: string | null
  /** channel 独立工作目录(omp 子进程 cwd;空串表示未设置) */
  workspace: string
  enabled: number
  /** 归属用户(null = 遗留数据) */
  ownerUserId: string | null
  /** v17 可见性:'private'(仅成员可见) | 'public'(登录用户可发现) */
  visibility: string
  /** v17 加入策略:'open'(直接加入) | 'owner_approve'(待 owner 批准) */
  joinPolicy: string
  /** v17 HITL 审批策略:'owner_only' | 'any_member' */
  approvalPolicy: string
  /** v17 群聊开关(0 = 未开启,群聊端点一律 409) */
  chatEnabled: number
  /** v17 乐观锁版本(每次设置变更 +1) */
  version: number
  createdAt: string
  updatedAt: string
}

/** channel_members 表行(v17 群成员;user_id = 全局用户系统 id) */
export interface ChannelMemberRow {
  channelId: string
  userId: string
  /** 'owner' | 'member' */
  role: string
  /** 'active' | 'left' | 'removed' | 'pending' */
  status: string
  /** 加入代数(退出再加 → +1;旧审批资格不恢复) */
  generation: number
  joinedAt: string
  leftAt: string | null
}

/** chat_messages 表行(v17 群聊事实表) */
export interface ChatMessageRow {
  id: string
  channelId: string
  /** 'user' | 'agent' | 'system' */
  senderType: string
  senderId: string
  senderName: string
  text: string
  mentionsJson: string
  replyToId: string | null
  requesterUserId: string | null
  sourceChatMessageId: string | null
  clientMessageId: string
  createdAt: string
}

/** chat_deliveries 表行(v17 群聊 → Agent mailbox 投递台账) */
export interface ChatDeliveryRow {
  id: string
  chatMessageId: string
  channelId: string
  targetAgentId: string
  mailboxMessageId: string | null
  /** pending | delivered | consumed | failed | cancelled */
  status: string
  error: string
  createdAt: string
  updatedAt: string
}

/** user_notifications 表行(v17 按 recipientUserId 定向的通知事实源) */
export interface UserNotificationRow {
  id: string
  recipientUserId: string
  channelId: string | null
  chatMessageId: string | null
  hitlKind: string | null
  hitlId: string | null
  eventId: string
  /** mention | agent_reply | hitl_request | hitl_resolved | member */
  type: string
  title: string
  body: string
  payloadJson: string
  createdAt: string
  readAt: string | null
}

/** outbox_events 表行(v17 事务内待发布事件) */
export interface OutboxEventRow {
  id: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payloadJson: string
  /** pending | published | failed */
  status: string
  attempts: number
  lastError: string
  createdAt: string
  publishedAt: string | null
}

/** hitl_requests 表行(v17 HITL 持久化事实源) */
export interface HitlRequestRow {
  id: string
  /** providerKind:omp-dialog | dcw-approval | codex-approval | ... */
  kind: string
  /** question | approval(§8 分开建模) */
  requestType: string
  nativeRequestId: string
  channelId: string
  agentId: string
  agentName: string
  sessionId: string
  harness: string
  mode: string
  title: string
  detail: string
  optionsJson: string
  questionsJson: string
  schemaJson: string
  /** pending|resolving|answered|approved|rejected|cancelled|expired|failed|delivery_unknown|reconciling */
  status: string
  /** owner_only | any_member */
  policy: string
  policySnapshotJson: string
  policyVersion: number
  decisionId: string | null
  responderUserId: string | null
  decisionJson: string
  /** 引擎原生确认成功 = 1(否则 0;§8 步骤 7) */
  nativeConfirmed: number
  error: string
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  expiresAt: string | null
}

/** users 表行(用户级隔离身份) */
export interface UserRow {
  id: string
  name: string
  /** 用户管理 token(Bearer;区别于 agent 实例 token) */
  token: string
  createdAt: string
}

/** channel_events 表行(AEP 事件持久化) */
export interface ChannelEventRow {
  id: number
  channelId: string
  seq: number
  type: string
  at: string
  agentId: string | null
  taskId: string | null
  payloadJson: string
}

/** workspaces 表行(服务端持久化 Workspace;按 owner 隔离) */
export interface WorkspaceRow {
  id: string
  ownerUserId: string
  name: string
  createdAt: string
}

/** agents 表行(全局 Agent 模板,无 channel 绑定) */
export interface AgentRow {
  id: string
  name: string
  harness: string
  configJson: string
  enabled: number
  /** 可见性:'private' 仅属主 | 'public' 全员可读可用(owner NULL = 内置,恒 public 不可变更) */
  visibility: string
  /** 归属用户(null = 内置公共模板) */
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** teams 表行(AgentTeam:Agent 模板的编组,可整体部署到 channel) */
export interface TeamRow {
  id: string
  name: string
  description: string
  /** 可见性:'private' 仅属主 | 'public' 全员可读可用(owner NULL = 内置,恒 public 不可变更) */
  visibility: string
  /** 归属用户(null = 内置公共模板) */
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * channel_templates 表行(Channel 模板:场景 + 工作目录 + 成员组合)。
 * membersJson 元素:{templateId, role} 引用 Agent 模板 | {inline:{name,harness,config}, role} 内联定义。
 */
export interface ChannelTemplateRow {
  id: string
  name: string
  description: string
  scenarioPrompt: string
  workspace: string
  leadJson: string
  membersJson: string
  visibility: string
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** team_members 表行(team × agent 模板 成员关系;role 为部署时采用的实例角色) */
export interface TeamMemberRow {
  teamId: string
  templateId: string
  role: string
  createdAt: string
}

/**
 * 记忆类别:episodic-task/episodic-peer/episodic-session/episodic-team-task(harvest 族,
 * 参与过期+淘汰)/ semantic(知识,免衰减)/ brief/chronicle/reflection(策展层,
 * 免向量化免维护)。TEXT 自由列(无 CHECK),联合类型仅约束调用面。
 */
export type MemoryKind
  = | 'episodic-task'
    | 'episodic-peer'
    | 'episodic-session'
    | 'episodic-team-task'
    | 'semantic'
    | 'brief'
    | 'chronicle'
    | 'reflection'

/** agent_memories 表行(content 为已 CJK 切分存储文本;agentId='__team__' 为团队共享行) */
export interface MemoryRow {
  id: string
  channelId: string
  agentId: string
  kind: MemoryKind
  title: string
  content: string
  importance: number
  taskId: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}
/** channel_agents 表行(Channel 中的 Agent 实例:独立身份 id + 复制自模板的字段) */
export interface ChannelAgentRow {
  id: string
  channelId: string
  templateId: string | null
  name: string
  harness: string
  configJson: string
  role: string
  token: string
  enabled: number
  createdAt: string
  updatedAt: string
}

/** messages 表行 */
export interface MessageRow {
  id: string
  channelId: string
  taskId: string | null
  fromAgentId: string | null
  toAgentId: string | null
  role: string
  partsJson: string
  metadataJson: string
  state: 'pending' | 'consuming' | 'consumed'
  createdAt: string
  consumedAt: string | null
}

/** subscriptions 表行(channel_id + agent_id + target_agent_id 复合主键) */
export interface SubscriptionRow {
  channelId: string
  agentId: string
  targetAgentId: string
  createdAt: string
}

/** tasks 表行 */
export interface TaskRow {
  id: string
  channelId: string
  parentId: string | null
  assigneeId: string
  creatorId: string | null
  title: string
  description: string | null
  state: string
  progress: number
  retryCount: number
  artifactsJson: string
  historyJson: string
  routeReason: string
  sourceChatMessageId: string | null
  sourceChatDeliveryId: string | null
  closeReason: string | null
  deadlineAt: string | null
  createdAt: string
  updatedAt: string
}

/** scheduled_tasks 表行(v16 定时任务) */
export interface ScheduledTaskRow {
  id: string
  channelId: string
  name: string
  title: string
  description: string
  /** 'interval' 固定间隔 | 'daily' 每日定点 */
  mode: string
  intervalMs: number
  /** 'HH:MM'(本地时区;daily 模式生效) */
  dailyTime: string
  enabled: number
  /** idle|waiting|running|disabled|failed(runtime 视图状态) */
  state: string
  lastRunAt: string | null
  nextRunAt: string | null
  lastTaskId: string | null
  runCount: number
  failCount: number
  consecutiveFailures: number
  maxConsecutiveFailures: number
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** scheduled_task_runs 表行(v16 定时任务运行历史) */
export interface ScheduledTaskRunRow {
  id: string
  scheduleId: string
  /** 'timer' 周期触发 | 'manual' 手动立即执行 */
  triggerKind: string
  taskId: string | null
  /** RUNNING|COMPLETED|FAILED */
  state: string
  error: string
  startedAt: string
  endedAt: string | null
}

/**
 * 打开(或创建)workshop 数据库并完成初始化。
 * path 传 ':memory:' 即为内存库(测试用);落盘库由上层决定路径。
 */
