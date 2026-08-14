/**
 * POST /api/workshop/a2a/:agentId.rpc —— A2A JSON-RPC 2.0 端点(设计文档 §6.3,规范 §7)。
 *
 * 方法:
 *  - tasks/send        外部消息转为 task(submitChannelTask / 直接任务消息投递)→ 阻塞等待终态(30s 超时)
 *  - tasks/sendSubscribe 同 tasks/send,但以 SSE(Content-Type: text/event-stream)流式输出
 *                       task/status-update/artifact-update/message 事件直到终态
 *  - tasks/get         按 taskId 查任务(作用域 = URL agent 所在 channel)
 *  - tasks/list        列 URL agent 所在 channel 的任务
 *  - tasks/cancel      取消任务(优先以 Authorization Bearer token 关联的 agent 身份,
 *                       无 token 时以任务所在 channel 的 lead 作为系统身份)
 *  - message/send      点对点发消息给 URL agent(需要有效 token 确定发送方,防冒用)
 *  - agent/getCard     返回 AgentCard
 *
 * 错误按 JSON-RPC 规范返回 error 对象:
 *  -32700 Parse error / -32600 Invalid Request / -32601 Method not found / -32602 Invalid params
 *  -32001 Agent not found / -32002 Task not found / -32003 Task not cancelable
 *  -32004 Unsupported operation / -32005 Agent not authorized / -32603 Internal error
 */
import { randomUUID } from 'node:crypto'
import { defineEventHandler, getRouterParam, readBody, createEventStream, type H3Event } from 'h3'
import { z } from 'zod'
import { AppError } from '../../../../../utils/errors'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { findAgent, buildAgentCard } from '../card/index.get'
import type { AgentChannelManager } from '../../../../../services/workshop/runtime/manager'
import type { TaskEngine } from '../../../../../services/workshop/runtime/agent-runtime'
import type { AgentInfo } from '../../../../../services/workshop/agents/agent-interface'
import type { A2AMessage, Part } from '../../../../../services/workshop/types/a2a'
import type { TaskState, WorkspaceTask } from '../../../../../services/workshop/types/task'

// ===== JSON-RPC 信封与错误 =====

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: unknown
  result?: unknown
  error?: JsonRpcError
}

/** 业务内可控的 JSON-RPC 错误(抛出后由外层转成 error 响应) */
class RpcMethodError extends Error {
  constructor(readonly error: JsonRpcError) {
    super(error.message)
    this.name = 'RpcMethodError'
  }
}

function fail(code: number, message: string): never {
  throw new RpcMethodError({ code, message })
}

function ok(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function err(id: unknown, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error }
}

/** AppError(平台业务错误)→ A2A 规范错误码(规范 §3.3.2) */
function appErrorToRpc(error: AppError): JsonRpcError {
  switch (error.code) {
    case 'NOT_FOUND':
      return { code: -32002, message: error.message }
    case 'SCOPE_VIOLATION':
      return { code: -32005, message: error.message }
    case 'INVALID_TRANSITION':
      return { code: -32003, message: error.message }
    case 'NO_LEAD_AGENT':
      return { code: -32004, message: error.message }
    default:
      return { code: -32603, message: error.message, data: { appCode: error.code } }
  }
}

// ===== zod 参数校验(与 MCP 层同构) =====

/** 运行时校验与契约 Part 一致;zod union 推断形状与契约存在无害差异,as 收窄类型 */
const partSchema = z.union([
  z.object({
    text: z.string(),
    mediaType: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    data: z.unknown(),
    mediaType: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    url: z.string(),
    mediaType: z.string().optional(),
    filename: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    raw: z.string(),
    mediaType: z.string().optional(),
    filename: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]) as z.ZodType<Part>

const messageSchema = z.object({
  role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
  parts: z.array(partSchema).min(1, 'parts 至少 1 个'),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
const sendParamsSchema = z.object({
  taskId: z.string().optional(),
  message: messageSchema,
  historyLength: z.number().int().nonnegative().optional(),
})
const taskIdParamsSchema = z.object({
  taskId: z.string().min(1, 'taskId 必填'),
})
const noopParamsSchema = z.record(z.string(), z.unknown()).optional()
const sendMessageParamsSchema = z.object({
  message: messageSchema,
})

function parseParams<S extends z.ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
  const result = schema.safeParse(params ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const detail = issue ? `${issue.path.join('.') || 'params'}: ${issue.message}` : '参数校验失败'
    fail(-32602, `Invalid params: ${detail}`)
  }
  return result.data
}

// ===== manager 内部访问(类型收窄) =====

/** manager 未公开 TaskEngine / 路由访问;经内部方法只读获取(与运行时同一实例) */
function internalsOf(manager: AgentChannelManager): { getTaskEngine(): TaskEngine, route(channelId: string, message: A2AMessage): void } {
  return manager as unknown as { getTaskEngine(): TaskEngine, route(channelId: string, message: A2AMessage): void }
}

// ===== A2A 语义映射 =====

const TERMINAL_STATES: Record<TaskState, boolean> = {
  SUBMITTED: false,
  ASSIGNED: false,
  WORKING: false,
  WAITING: false,
  COMPLETED: true,
  FAILED: true,
  CANCELED: true,
}

function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES[state] === true
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setTimeout(resolve, ms)
  return promise
}

/** WorkspaceTask → A2A Task(规范 §7 字段子集) */
function toA2ATask(task: WorkspaceTask) {
  return {
    id: task.id,
    contextId: task.channelId,
    status: { state: task.state, timestamp: task.updatedAt },
    artifacts: task.artifacts,
    history: task.history,
    metadata: {
      assigneeId: task.assigneeId,
      creatorId: task.creatorId,
      title: task.title,
      progress: task.progress,
    },
  }
}

/** 从 parts 提取任务标题(拼接 text 片段) */
function extractTitle(parts: Part[]): string {
  const text = parts
    .map(p => (p as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join(' ')
    .trim()
  return text || 'A2A 任务'
}

/**
 * 外部消息转为 task:
 *  - lead:channel 级任务(submitChannelTask,SUBMITTED → 调度循环 dispatch 分发)
 *  - worker:直接任务消息投递(create + ASSIGNED + assign 消息 → 其 mailbox 自动接取)
 */
async function submitTask(manager: AgentChannelManager, agent: AgentInfo, params: z.infer<typeof sendParamsSchema>): Promise<WorkspaceTask> {
  const parts = params.message.parts as Part[]
  const title = extractTitle(parts)
  const description
    = typeof params.message.metadata?.description === 'string' ? params.message.metadata.description : undefined
  if (agent.role === 'lead') {
    return manager.submitChannelTask({ channelId: agent.channelId, title, description, parts })
  }
  const engine = internalsOf(manager).getTaskEngine()
  const task = engine.create({
    channelId: agent.channelId,
    creatorId: '',
    assigneeId: agent.id,
    title,
    description,
    parts,
  })
  engine.transition(task.id, 'ASSIGNED', agent.id)
  const message: A2AMessage = {
    messageId: randomUUID(),
    contextId: agent.channelId,
    taskId: task.id,
    role: 'ROLE_USER',
    parts,
    metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': task.id },
  }
  internalsOf(manager).route(agent.channelId, message)
  return engine.get(task.id)!
}

/** 阻塞轮询任务终态(默认 30s 超时 → -32603) */
async function waitTerminal(manager: AgentChannelManager, taskId: string, timeoutMs = 30_000): Promise<WorkspaceTask> {
  const engine = internalsOf(manager).getTaskEngine()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = engine.get(taskId)
    if (task && isTerminal(task.state)) return task
    if (Date.now() >= deadline) fail(-32603, `任务执行超时: ${taskId}`)
    await sleep(50)
  }
}

/** 从 Authorization: Bearer 头解析 caller token */
function bearerTokenOf(event: H3Event): string | undefined {
  const header = event.headers.get('authorization') ?? event.headers.get('Authorization')
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim()
}

/** 取消任务:优先 token 关联 agent;无 caller 时以任务所在 channel 的 lead 作为系统身份 */
async function cancelTaskWithCaller(
  manager: AgentChannelManager,
  event: H3Event,
  taskId: string,
): Promise<WorkspaceTask> {
  const token = bearerTokenOf(event)
  const caller = token ? manager.findByToken(token) : undefined
  if (caller) return manager.cancelTask(caller.channelId, caller.id, { taskId })
  const task = internalsOf(manager).getTaskEngine().get(taskId)
  if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
  const agents = await manager.listChannelAgents(task.channelId)
  const lead = agents.find(a => a.role === 'lead')
  if (!lead) throw new AppError(400, 'NO_LEAD_AGENT', `channel ${task.channelId} 无 lead,无法以系统身份取消`)
  return manager.cancelTask(lead.channelId, lead.id, { taskId })
}

// ===== SSE(tasks/sendSubscribe) =====

/** 推送安全包装:客户端断开后 push 抛错 → 返回 false,调用方结束循环 */
async function safePush(stream: ReturnType<typeof createEventStream>, message: { event?: string, data: string }): Promise<boolean> {
  try {
    await stream.push(message)
    return true
  }
  catch {
    return false
  }
}

/** 流式输出 task/status-update/artifact-update/message 直到终态(50ms 轮询观测) */
async function runSubscribe(
  stream: ReturnType<typeof createEventStream>,
  manager: AgentChannelManager,
  agent: AgentInfo,
  params: z.infer<typeof sendParamsSchema>,
): Promise<void> {
  try {
    const task = await submitTask(manager, agent, params)
    const engine = internalsOf(manager).getTaskEngine()
    let lastState: TaskState | undefined
    let lastArtifacts = 0
    let lastHistory = 0
    const deadline = Date.now() + 30_000
    // 初始 Task 对象(规范 §9:task 事件)
    if (!(await safePush(stream, { event: 'task', data: JSON.stringify(toA2ATask(task)) }))) return
    for (;;) {
      const current = engine.get(task.id)
      if (!current) break
      for (const artifact of current.artifacts.slice(lastArtifacts)) {
        if (!(await safePush(stream, { event: 'artifact-update', data: JSON.stringify({ taskId: current.id, artifact }) }))) return
      }
      lastArtifacts = current.artifacts.length
      for (const message of current.history.slice(lastHistory)) {
        if (!(await safePush(stream, { event: 'message', data: JSON.stringify({ taskId: current.id, message }) }))) return
      }
      lastHistory = current.history.length
      if (current.state !== lastState) {
        lastState = current.state
        if (!(await safePush(stream, { event: 'status-update', data: JSON.stringify({ taskId: current.id, status: { state: current.state, timestamp: current.updatedAt } }) }))) return
      }
      if (isTerminal(current.state)) {
        // 终态:末尾补发最终 Task 对象
        await safePush(stream, { event: 'task', data: JSON.stringify(toA2ATask(current)) })
        break
      }
      if (Date.now() >= deadline) break
      await sleep(50)
    }
  }
  catch (error) {
    const rpcError = error instanceof RpcMethodError ? error.error : { code: -32603, message: error instanceof Error ? error.message : String(error) }
    await safePush(stream, { event: 'error', data: JSON.stringify(rpcError) })
  }
  finally {
    try {
      await stream.close()
    }
    catch {
      // 连接已断开
    }
  }
}

// ===== 方法分发 =====

async function dispatch(
  event: H3Event,
  manager: AgentChannelManager,
  agentId: string,
  id: unknown,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case 'tasks/send': {
      const p = parseParams(sendParamsSchema, params)
      const agent = findAgent(manager, agentId) ?? fail(-32001, `Agent not found: ${agentId}`)
      const task = await submitTask(manager, agent, p)
      const final = await waitTerminal(manager, task.id)
      return ok(id, toA2ATask(final))
    }
    case 'tasks/sendSubscribe': {
      const p = parseParams(sendParamsSchema, params)
      const agent = findAgent(manager, agentId) ?? fail(-32001, `Agent not found: ${agentId}`)
      const stream = createEventStream(event)
      void runSubscribe(stream, manager, agent, p)
      return stream
    }
    case 'tasks/get': {
      const p = parseParams(taskIdParamsSchema, params)
      const agent = findAgent(manager, agentId) ?? fail(-32001, `Agent not found: ${agentId}`)
      const task = await manager.getTask(agent.channelId, agent.id, p.taskId)
      return ok(id, toA2ATask(task))
    }
    case 'tasks/list': {
      parseParams(noopParamsSchema, params)
      const agent = findAgent(manager, agentId) ?? fail(-32001, `Agent not found: ${agentId}`)
      const tasks = await manager.listTasks(agent.channelId, agent.id)
      return ok(id, tasks.map(toA2ATask))
    }
    case 'tasks/cancel': {
      const p = parseParams(taskIdParamsSchema, params)
      if (!findAgent(manager, agentId)) fail(-32001, `Agent not found: ${agentId}`)
      const canceled = await cancelTaskWithCaller(manager, event, p.taskId)
      return ok(id, toA2ATask(canceled))
    }
    case 'message/send': {
      const p = parseParams(sendMessageParamsSchema, params)
      if (!findAgent(manager, agentId)) fail(-32001, `Agent not found: ${agentId}`)
      const token = bearerTokenOf(event)
      const caller = token ? manager.findByToken(token) : undefined
      if (!caller) fail(-32005, 'Agent not authorized: message/send 需要有效 token 确定发送方')
      const message = await manager.sendA2A(caller.channelId, caller.id, {
        toAgentId: agentId,
        parts: p.message.parts,
        metadata: p.message.metadata,
      })
      return ok(id, message)
    }
    case 'agent/getCard': {
      parseParams(noopParamsSchema, params)
      const agent = findAgent(manager, agentId) ?? fail(-32001, `Agent not found: ${agentId}`)
      return ok(id, buildAgentCard(agent))
    }
    default:
      fail(-32601, `Method not found: ${method}`)
  }
}

/** POST /api/workshop/a2a/:agentId.rpc —— JSON-RPC 2.0 请求入口 */
export default defineEventHandler(async (event) => {
  const agentId = getRouterParam(event, 'agentId')!
  const manager = getWorkshopManager()

  let raw: unknown
  try {
    raw = await readBody(event)
  }
  catch {
    return err(null, { code: -32700, message: 'Parse error' })
  }
  if (typeof raw !== 'object' || raw === null) {
    return err(null, { code: -32600, message: 'Invalid Request' })
  }
  const req = raw as { jsonrpc?: unknown, id?: unknown, method?: unknown, params?: unknown }
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return err(req.id ?? null, { code: -32600, message: 'Invalid Request' })
  }
  const id = req.id ?? null
  try {
    return await dispatch(event, manager, agentId, id, req.method, req.params)
  }
  catch (error) {
    if (error instanceof RpcMethodError) return err(id, error.error)
    if (error instanceof AppError) return err(id, appErrorToRpc(error))
    console.error('[workshop-a2a-rpc] 未处理异常:', error)
    return err(id, { code: -32603, message: 'Internal error' })
  }
})
