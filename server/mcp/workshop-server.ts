/**
 * MCP Server — Agent 自主作业面(L3 绑定,四入口之一)。
 * 用 @modelcontextprotocol/sdk 注册工具,Agent 经 token 认证后自主调用。
 * 权威契约见 docs/superpowers/specs/2026-08-13-agent-workshop-multi-agent-design.md §6.1。
 *
 * 身份凭证:每个 Channel 成员(agent × channel)创建时生成 token(UUIDv4,存 channel_agents.token)。
 * 工具 handler 从请求 extra 解析 caller token:
 *   1. `Authorization: Bearer <token>` 头(extra.requestInfo.headers)
 *   2. auth 中间件注入的 token(extra.authInfo.token)
 * 无 token 或无效 token → throw new Error('UNAUTHORIZED')(SDK 转为工具错误)。
 * 管理面工具(channel.create/remove、agent.create/add/remove、channel.list、task.submit)不要求 token。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentChannelManager } from '../services/workshop/runtime/manager'
import type { AgentInfo } from '../services/workshop/agents/agent-interface'
import type { A2AArtifact, Part } from '../services/workshop/types/a2a'
import { getDeviceTwinRepo } from '../services/workshop/assets/device-twin.repo'

/** A2A 消息片段(Part):四种变体(text/data/url/raw)。运行时校验与契约一致;zod union 推断形状与契约存在无害差异,as 收窄 */
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

/** A2A 成果(Artifact):任务作业产出的内容集合 */
const artifactSchema = z.object({
  artifactId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(partSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
}) as z.ZodType<A2AArtifact>

/** 可从中解析 caller token 的最小请求上下文(handler 的 extra 结构化兼容) */
interface TokenSource {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> }
  authInfo?: { token?: string }
}

/** 从请求 extra 解析 caller token:优先 Authorization: Bearer 头,其次 auth 中间件注入的 token */
function resolveToken(extra: TokenSource): string | undefined {
  const headers = extra.requestInfo?.headers
  const raw = headers?.['authorization'] ?? headers?.['Authorization']
  if (typeof raw === 'string') {
    const match = raw.match(/^Bearer\s+(.+)$/i)
    if (match) return match[1]!.trim()
  }
  if (extra.authInfo?.token) return extra.authInfo.token
  return undefined
}

/** 解析 caller:无 token / 无效 token 一律拒绝(防冒用) */
function requireCaller(manager: AgentChannelManager, extra: TokenSource): AgentInfo {
  const token = resolveToken(extra)
  if (!token) throw new Error('UNAUTHORIZED')
  const caller = manager.findByToken(token)
  if (!caller) throw new Error('UNAUTHORIZED')
  return caller
}

/** 构造工具成功结果(JSON 文本内容) */
function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

/**
 * 创建 Workshop MCP Server:注册 §6.1 表中的工具。
 * 名/参数/说明与设计文档 §6.1 逐字一致。
 */
export function createWorkshopMcpServer(manager: AgentChannelManager): McpServer {
  const server = new McpServer(
    { name: 'agent-workshop', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // ===== channel(管理面) =====

  server.registerTool(
    'workshop.channel.create',
    {
      description: '创建 channel(可同时创建主理人)',
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        leadAgent: z
          .object({
            name: z.string(),
            harness: z.string(),
            config: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      const result = await manager.createChannel({
        name: args.name,
        description: args.description,
        leadAgent: args.leadAgent,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.channel.list',
    {
      description: '全部 channel',
      inputSchema: {},
    },
    async () => {
      return jsonResult(await manager.listChannels())
    },
  )

  server.registerTool(
    'workshop.channel.remove',
    {
      description: '删除(级联)',
      inputSchema: { channelId: z.string() },
    },
    async (args) => {
      await manager.removeChannel(args.channelId)
      return jsonResult({ ok: true })
    },
  )

  // ===== agent =====

  server.registerTool(
    'workshop.agent.create',
    {
      description: '创建 Agent 模板(可复用数据结构;放入 channel 用 agent.add 克隆)',
      inputSchema: {
        name: z.string(),
        harness: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      const result = await manager.createAgent({
        name: args.name,
        harness: args.harness,
        config: args.config,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.agent.add',
    {
      description: '把 Agent 模板放入 channel → 克隆出独立身份 id 的新实例(role=lead/worker)',
      inputSchema: {
        channelId: z.string(),
        agentId: z.string(),
        role: z.enum(['lead', 'worker']),
      },
    },
    async (args) => {
      const result = await manager.addAgentToChannel({
        channelId: args.channelId,
        agentId: args.agentId,
        role: args.role,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.agent.definitions',
    {
      description: '列出全部 Agent 模板(全局可复用)',
      inputSchema: {},
    },
    async () => {
      return jsonResult(await manager.listAgents())
    },
  )

  server.registerTool(
    'workshop.agent.list',
    {
      description: '列同事(channel 内实例;Agent 只能看到自己 channel)',
      inputSchema: {},
    },
    async (_args, extra) => {
      const caller = requireCaller(manager, extra)
      return jsonResult(await manager.listChannelAgents(caller.channelId))
    },
  )

  server.registerTool(
    'workshop.agent.remove',
    {
      description: '删除 Agent 模板(已克隆实例保留)',
      inputSchema: { agentId: z.string() },
    },
    async (args) => {
      await manager.removeAgent(args.agentId)
      return jsonResult({ ok: true })
    },
  )

  // ===== task =====

  server.registerTool(
    'workshop.task.submit',
    {
      description: '向 channel 发任务 → lead',
      inputSchema: {
        channelId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        parts: z.array(partSchema).optional(),
      },
    },
    async (args) => {
      const result = await manager.submitChannelTask({
        channelId: args.channelId,
        title: args.title,
        description: args.description,
        parts: args.parts,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.task.dispatch',
    {
      description: '分解指派子任务',
      inputSchema: {
        parentTaskId: z.string().optional(),
        assigneeId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        parts: z.array(partSchema).optional(),
        routeReason: z.string().optional(),
      },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      const result = await manager.dispatchTask(caller.channelId, caller.id, {
        parentTaskId: args.parentTaskId,
        assigneeId: args.assigneeId,
        title: args.title,
        description: args.description,
        parts: args.parts,
        routeReason: args.routeReason,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.task.list',
    {
      description: '看全 channel 任务与进度',
      inputSchema: {},
    },
    async (_args, extra) => {
      const caller = requireCaller(manager, extra)
      return jsonResult(await manager.listTasks(caller.channelId, caller.id))
    },
  )

  server.registerTool(
    'workshop.task.get',
    {
      description: '看同事作业内容与成果',
      inputSchema: { taskId: z.string() },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      return jsonResult(await manager.getTask(caller.channelId, caller.id, args.taskId))
    },
  )

  server.registerTool(
    'workshop.task.report',
    {
      description: '上报进度/成果',
      inputSchema: {
        taskId: z.string(),
        progress: z.number().min(0).max(100).optional(),
        artifact: artifactSchema.optional(),
        message: z.string().optional(),
      },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      const result = await manager.reportTask(caller.channelId, caller.id, {
        taskId: args.taskId,
        progress: args.progress,
        artifact: args.artifact,
        message: args.message,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.task.complete',
    {
      description: '完成任务',
      inputSchema: {
        taskId: z.string(),
        artifacts: z.array(artifactSchema).optional(),
      },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      const result = await manager.completeTask(caller.channelId, caller.id, {
        taskId: args.taskId,
        artifacts: args.artifacts,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.task.cancel',
    {
      description: '取消任务(卡死回收;向 assignee 投递 x-aw-task-kind: cancel)',
      inputSchema: { taskId: z.string() },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      const result = await manager.cancelTask(caller.channelId, caller.id, { taskId: args.taskId })
      return jsonResult(result)
    },
  )

  // ===== a2a =====

  server.registerTool(
    'workshop.a2a.send',
    {
      description: '与同事点对点通信',
      inputSchema: {
        toAgentId: z.string(),
        parts: z.array(partSchema),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args, extra) => {
      // fromAgentId 由 token 决定(caller.id),不接受请求体自报
      const caller = requireCaller(manager, extra)
      const result = await manager.sendA2A(caller.channelId, caller.id, {
        toAgentId: args.toAgentId,
        parts: args.parts,
        metadata: args.metadata,
      })
      return jsonResult(result)
    },
  )

  server.registerTool(
    'workshop.a2a.poll',
    {
      description: '拉取自己的消息',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      return jsonResult(await manager.pollMailbox(caller.channelId, caller.id, args.limit))
    },
  )

  server.registerTool(
    'workshop.mail.list',
    {
      description: '(仅 lead)Channel 邮件全览:查看全部 agent 间点对点通信记录(含已消费/任务投递),按时间倒序。派发任务前先查此处,判断"该结果是否已被某 worker 经 mail 产出",避免重复派发浪费资源。',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        agentId: z.string().optional(),
      },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      return jsonResult(await manager.listChannelMail(caller.channelId, caller.id, {
        limit: args.limit,
        agentId: args.agentId,
      }))
    },
  )

  server.registerTool(
    'workshop.queue.overview',
    {
      description: '全员实时状态与任务队列总览(每个成员 idle/busy/stopped + 执行中任务 + 待执行数 + 已完成数),lead 做最优调配的依据',
      inputSchema: {},
    },
    async (_args, extra) => {
      const caller = requireCaller(manager, extra)
      return jsonResult(await manager.queueOverview(caller.channelId, caller.id))
    },
  )

  server.registerTool(
    'workshop.a2a.subscribe',
    {
      description: '订阅同事产出',
      inputSchema: { agentIds: z.array(z.string()).optional() },
    },
    async (args, extra) => {
      const caller = requireCaller(manager, extra)
      await manager.subscribe(caller.channelId, caller.id, { agentIds: args.agentIds })
      return jsonResult({ ok: true })
    },
  )

  // ===== device 数字孪生(赛博物理闭环:数字人经 MCP 控制真实/虚拟设备) =====
  // 让 Agent 读取设备遥测、下发指令、绑定自己为控制者,实现 MAS↔物理闭环。
  // 真实设备接入时,由采集器推 telemetry 到 device-twins API,Agent 经这些工具下发 desired 指令。

  server.registerTool(
    'device.list',
    {
      description: '列出数字孪生设备(含 telemetry/state/desired)。Agent 据此判断哪些设备可控、当前状态如何。',
      inputSchema: { workspaceId: z.string().optional() },
    },
    async (args) => {
      return jsonResult(getDeviceTwinRepo().listAll(args.workspaceId))
    },
  )

  server.registerTool(
    'device.read',
    {
      description: '读取单个设备实时遥测 + 运行状态 + 可用指令集。数字人作业前先 read 感知设备当前情况。',
      inputSchema: { deviceId: z.string() },
    },
    async (args) => {
      const twin = getDeviceTwinRepo().findById(args.deviceId)
      if (!twin) throw new Error(`NOT_FOUND: 设备不存在 ${args.deviceId}`)
      return jsonResult(twin)
    },
  )

  server.registerTool(
    'device.control',
    {
      description: '对设备下发控制指令(如 power_on/power_off/set_speed/set_temperature/stop),写 desired 并驱动 state。数字人据此远程操作设备。',
      inputSchema: {
        deviceId: z.string(),
        command: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      const twin = getDeviceTwinRepo().applyControl(args.deviceId, args.command, args.args ?? {})
      if (!twin) throw new Error(`NOT_FOUND: 设备不存在 ${args.deviceId}`)
      return jsonResult(twin)
    },
  )

  server.registerTool(
    'device.push_telemetry',
    {
      description: '将数字孪生数据采集写入设备(采集器/传感器模拟)。真实设备 OPC-UA/MQTT 采集器亦可对接本工具。',
      inputSchema: {
        deviceId: z.string(),
        telemetry: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      },
    },
    async (args) => {
      const twin = getDeviceTwinRepo().applyTelemetry(args.deviceId, args.telemetry)
      if (!twin) throw new Error(`NOT_FOUND: 设备不存在 ${args.deviceId}`)
      return jsonResult({ state: twin.state, telemetry: twin.telemetry })
    },
  )

  server.registerTool(
    'device.bind_agent',
    {
      description: '把 Agent 绑定为某设备的控制者(数字人接管设备)。绑定后该 Agent 的 MCP 调用即代表操作该设备。',
      inputSchema: { deviceId: z.string(), agentId: z.string() },
    },
    async (args, extra) => {
      requireCaller(manager, extra)
      const twin = getDeviceTwinRepo().update(args.deviceId, { boundAgentId: args.agentId })
      if (!twin) throw new Error(`NOT_FOUND: 设备不存在 ${args.deviceId}`)
      return jsonResult(twin)
    },
  )

  return server
}
