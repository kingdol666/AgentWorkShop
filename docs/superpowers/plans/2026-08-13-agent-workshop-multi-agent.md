# AgentWorkShop 多 Agent 协同作业系统 实施计划

> **For agentic workers:** 按任务并行调度;每任务只运行自己的测试文件,禁止全量 typecheck/lint。

**Goal:** 实现设计文档 12 章的全部内容:harness 无关 Agent 接口 + Channel 隔离 + lead 调度循环 + 任务引擎 + 四入口(MCP/REST/A2A/WS)。

**Architecture:** L1(A2A 类型+sqlite)→ L2(运行时四对象+SchedulerLoop)→ L3(四入口)→ impl 层(mock/claude/omp)。分层依赖,接口契约见各任务 Interfaces 块。

**Tech Stack:** Nuxt 4 / Nitro / node:sqlite(Node 24 内置) / zod / @modelcontextprotocol/sdk 1.30 / tsx

## Global Constraints

- 设计文档: `docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md`(权威,矛盾时以文档为准)
- **禁止修改** game 模块(`server/services/game/**`、`shared/game-protocol.*`、`app/game/**`、`server/api/game/**`)
- 代码风格与现有 server 一致: 中文注释 + defineApiHandler/AppError/zod 分层
- 测试风格与 `scripts/test-protocol.ts` 一致(PASS/FAIL + failures 计数 + process.exit)
- **每个任务只允许运行自己的测试文件**(`npx tsx scripts/test-<own>.ts`);禁止 nuxt typecheck、eslint、其他任务的文件
- 所有 ID 用 `crypto.randomUUID()`;时间用 `new Date().toISOString()`
- sqlite 用 `node:sqlite` 的 `DatabaseSync`;依赖注入(db/repos/impl 全部构造传入,不 import 单例)

## 任务分波(依赖序)

```
Wave 1: T1 类型+接口 ─┬─> Wave 2: T3 运行时核心 ─┬─> Wave 3: T5 调度+Mock ─┬─> Wave 4: T7 入口 + T8 骨架
         T2 sqlite仓库 ─┤          T4 TaskEngine ─┤          T6 MCP server ─┘
Wave 5: 集成验证(主会话)
```

## 核心契约(跨任务接口,实现方与消费方必须逐字一致)

```typescript
// server/services/workshop/types/a2a.ts
export type Part =
  | { text: string, mediaType?: string, metadata?: Record<string, unknown> }
  | { data: unknown, mediaType?: string, metadata?: Record<string, unknown> }
  | { url: string, mediaType?: string, filename?: string, metadata?: Record<string, unknown> }
  | { raw: string, mediaType?: string, filename?: string, metadata?: Record<string, unknown> }
export interface A2AMessage {
  messageId: string; contextId: string; taskId?: string
  role: 'ROLE_USER' | 'ROLE_AGENT'; parts: Part[]
  metadata?: Record<string, unknown>; extensions?: string[]; referenceTaskIds?: string[]
}
export interface A2AArtifact { artifactId: string; name?: string; description?: string; parts: Part[]; metadata?: Record<string, unknown> }
export interface A2AError { code: string; message: string; data?: unknown }

// server/services/workshop/types/task.ts
export type TaskState = 'SUBMITTED' | 'ASSIGNED' | 'WORKING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELED'
export interface WorkspaceTask {
  id: string; channelId: string; parentId?: string; assigneeId: string; creatorId: string
  title: string; description?: string; state: TaskState; progress: number; retryCount: number
  artifacts: A2AArtifact[]; history: A2AMessage[]; createdAt: string; updatedAt: string
}

// server/services/workshop/agents/agent-interface.ts
export interface AgentInfo {
  id: string; channelId: string; name: string; harness: string
  role: 'lead' | 'worker'; config: Record<string, unknown>; token?: string
}
export interface AgentRunRequest {
  message: A2AMessage; taskId?: string; contextId: string
  fromAgentId: string | null; toAgentId: string | null
}
export interface AgentWorkspace {
  listAgents(): Promise<AgentInfo[]>
  dispatchTask(input: { parentTaskId?: string, assigneeId: string, title: string, description?: string, parts?: Part[] }): Promise<WorkspaceTask>
  listTasks(): Promise<WorkspaceTask[]>
  getTask(taskId: string): Promise<WorkspaceTask>
  reportTask(input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string }): Promise<WorkspaceTask>
  completeTask(taskId: string, artifacts?: A2AArtifact[]): Promise<WorkspaceTask>
  cancelTask(taskId: string): Promise<WorkspaceTask>
  sendMessage(input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> }): Promise<A2AMessage>
  pollMailbox(limit?: number): Promise<A2AMessage[]>
  subscribe(input: { agentIds?: string[] }): Promise<void>
}
export interface AgentRunContext {
  agentId: string; channelId: string; role: 'lead' | 'worker'
  workspace: AgentWorkspace; signal: AbortSignal
}
export type AgentEvent =
  | { kind: 'status', status: { state: string, message?: A2AMessage, timestamp: string } }
  | { kind: 'message', message: A2AMessage }
  | { kind: 'artifact', artifact: A2AArtifact, append?: boolean, lastChunk?: boolean, totalChunks?: number }
  | { kind: 'error', error: A2AError }
  | { kind: 'done', final?: { taskId?: string } }
export interface SupervisionSnapshot {
  tick: number; now: number; tasks: WorkspaceTask[]
  members: { agentId: string, name: string, role: 'lead' | 'worker', state: 'idle' | 'busy' | 'stopped' }[]
  pendingChildren: Record<string, number>
}
export type SupervisionDecision =
  | { kind: 'dispatch', parentTaskId?: string, assigneeId: string, title: string, description?: string, parts?: Part[] }
  | { kind: 'reassign', taskId: string, toAgentId: string }
  | { kind: 'cancel', taskId: string }
  | { kind: 'complete', taskId: string, artifacts?: A2AArtifact[] }
  | { kind: 'notify', toAgentId: string, parts: Part[] }
export interface AgentInterface {
  run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent>
  supervise?(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]>
  init?(config: { agent: AgentInfo; channelId: string }): Promise<void>
  dispose?(): Promise<void>
}

// server/services/workshop/db/ 行类型(repo 返回)
export interface ChannelRow { id: string; name: string; description: string; leadAgentId: string | null; enabled: number; createdAt: string; updatedAt: string }
export interface AgentRow { id: string; channelId: string; name: string; harness: string; role: string; token: string; configJson: string; enabled: number; createdAt: string; updatedAt: string }
export interface MessageRow { id: string; channelId: string; taskId: string | null; fromAgentId: string | null; toAgentId: string | null; role: string; partsJson: string; metadataJson: string; state: 'pending' | 'consuming' | 'consumed'; createdAt: string; consumedAt: string | null }
export interface TaskRow { id: string; channelId: string; parentId: string | null; assigneeId: string; creatorId: string | null; title: string; description: string | null; state: string; progress: number; retryCount: number; artifactsJson: string; historyJson: string; createdAt: string; updatedAt: string }

// T4 TaskEngine(消费方: T3/T5/T7)
export class TaskEngine {
  constructor(repos: { tasks: TaskRepo; messages: MessageRepo })
  create(input: { channelId: string, creatorId: string, assigneeId: string, title: string, description?: string, parentId?: string, parts?: Part[] }): WorkspaceTask
  dispatch(parent: WorkspaceTask, input: { assigneeId: string, title: string, description?: string, parts?: Part[] }): WorkspaceTask
  transition(taskId: string, state: TaskState, by: string): WorkspaceTask
  applyEvent(taskId: string, event: AgentEvent): void
  list(channelId: string): WorkspaceTask[]
  get(taskId: string): WorkspaceTask | undefined
  complete(taskId: string, artifacts?: A2AArtifact[]): WorkspaceTask
  reassign(taskId: string, toAgentId: string): WorkspaceTask
  cancel(taskId: string, by: string): WorkspaceTask
  /** 子任务完成时: 更新 pendingChildren;最后一个完成→父任务 WAITING→WORKING + 向父 assignee 投 child-completed 消息 */
  onChildCompleted(child: WorkspaceTask): void
}

// T3 运行时(消费方: T5/T7)
export class Mailbox {
  constructor(messageRepo: MessageRepo, agentId: string, wake: () => void)
  enqueue(message: A2AMessage): void
  dequeue(): Promise<A2AMessage | null>
  peek(limit: number): Promise<A2AMessage[]>
  markConsumed(messageId: string): void
}
export class AgentRuntime {
  constructor(agent: AgentInfo, impl: AgentInterface, deps: { mailbox: Mailbox; taskEngine: TaskEngine; bus: ChannelBus; workspace: AgentWorkspace })
  enqueue(message: A2AMessage): void
  getState(): 'idle' | 'busy' | 'stopped'
  abortCurrent(): void
  start(): void
  stop(): Promise<void>
}
export interface ChannelBus { emit(event: AgentEvent, source: A2AMessage): void; onTaskEvent(fn: (e: { taskId: string, state?: TaskState, progress?: number }) => void): void; wakeScheduler(): void }
export class ChannelRuntime {
  constructor(channelId: string, deps: { taskEngine: TaskEngine })
  route(message: A2AMessage): void
  addAgent(runtime: AgentRuntime): void
  removeAgent(agentId: string): Promise<void>
  resolveRecipients(message: A2AMessage): string[]
  getAgents(): AgentRuntime[]
  get lead(): AgentRuntime | null
  set scheduler(loop: { start(): void; wake(): void; stop(): void } | null): void
}
export class AgentChannelManager {
  constructor(deps: { channels: ChannelRuntimeMap; repos: AllRepos; implFactory: (agent: AgentInfo) => AgentInterface; db: DatabaseSync })
  createChannel(input: { name: string, description?: string, leadAgent?: { name: string, harness: string, config?: Record<string, unknown> } }): Promise<{ channelId: string, leadAgentId?: string }>
  listChannels(): Promise<ChannelRow[]>
  removeChannel(channelId: string): Promise<void>
  createAgent(input: { channelId: string, name: string, harness: string, role: 'lead' | 'worker', config?: Record<string, unknown> }): Promise<AgentInfo>
  listAgents(channelId: string): Promise<AgentInfo[]>
  removeAgent(agentId: string): Promise<void>
  submitChannelTask(input: { channelId: string, title: string, description?: string, parts?: Part[] }): Promise<WorkspaceTask>
  dispatchTask(callerAgentId: string, input: { parentTaskId?: string, assigneeId: string, title: string, description?: string, parts?: Part[] }): Promise<WorkspaceTask>
  reportTask(callerAgentId: string, input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string }): Promise<WorkspaceTask>
  completeTask(callerAgentId: string, input: { taskId: string, artifacts?: A2AArtifact[] }): Promise<WorkspaceTask>
  cancelTask(callerAgentId: string, input: { taskId: string }): Promise<WorkspaceTask>
  listTasks(callerAgentId: string): Promise<WorkspaceTask[]>
  getTask(callerAgentId: string, taskId: string): Promise<WorkspaceTask>
  sendA2A(callerAgentId: string, input: { toAgentId: string, parts: Part[], metadata?: Record<string, unknown> }): Promise<A2AMessage>
  pollMailbox(callerAgentId: string, limit?: number): Promise<A2AMessage[]>
  subscribe(callerAgentId: string, input: { agentIds?: string[] }): Promise<void>
  findByToken(token: string): AgentInfo | undefined
  restore(): Promise<void>
}

// T5 调度与工厂
export class SchedulerLoop {
  constructor(channelRuntime: ChannelRuntime, lead: AgentRuntime, options?: { tickMs?: number })
  start(): void; wake(): void; stop(): void
}
export function createAgentImpl(agent: AgentInfo): AgentInterface  // mock/claude/omp;未知 harness 抛 AppError

// T6 MCP(消费方: T7 plugin)
export function createWorkshopMcpServer(manager: AgentChannelManager): McpServer  // 16 工具;Bearer token 认证

// T7 入口
// server/api/workshop/*.ts — REST(defineApiHandler);server/api/workshop/a2a/[agentId].card.get.ts + rpc.post.ts;
// server/api/workshop/ws.ts — /ws/workshop/:channelId;server/plugins/workshop.ts — restore + 注入单例
```

## 任务清单

见各 task 指令(调度时下发)。
