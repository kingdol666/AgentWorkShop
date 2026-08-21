/**
 * Agent-UI 渲染协议 — 类型桥 + 指令解析器(CMDParser)
 *
 * 本文件是前后端交互的运行时单一事实来源,与 `./game-protocol.json` 共同构成协议层:
 *  - JSON: 人类可编辑的注册表(envelope/downlink/uplink/agentContext/brainEvents),权威描述每条
 *    指令的参数 schema、描述、是否 Agent 可调用(agentCallable)、示例。
 *  - 本文件: 加载 JSON → 编译 JSON Schema 为 zod → 提供 CMDParser 在消息边界做权威校验,
 *    并派生 wire 类型 + 暴露 MCP 工具词表。
 *
 * 设计原则:
 *  - "改 JSON 即生效": CMDParser 的校验 schema 全部由 JSON 的 inputSchema 在运行时编译而来,
 *    无需手写第二份校验逻辑。新增指令只需在 JSON 注册 + 在 wire 类型与 dispatch switch 补一条。
 *  - 单一解析入口: 上行(ws.ts)与下行(client.ts)都经过 CMDParser,保证线格式始终受协议约束。
 *  - MCP 就绪: downlink 中 agentCallable=true 的指令即 Agent 可调用的工具集(toMcpTools),
 *    后续真实 Agent harness 通过 session.execDownlink(name, payload) 注入指令即可驱动 UI 渲染。
 */
import { z } from 'zod'
import protocolJson from './game-protocol.json'

// ============================================================================
// 1. 注册表加载 + 结构化类型
// ============================================================================

/** 单条指令的注册描述(对应 JSON 中 downlink/uplink 的每个条目) */
export interface CommandDef {
  /** 仅 downlink:是否可由 Agent(MCP 工具)直接调用 */
  agentCallable?: boolean
  /** 人类可读说明(同时作为 MCP 工具 description) */
  description: string
  /** payload 的 JSON Schema,运行时编译为 zod 做权威校验 */
  inputSchema: JsonObjectSchema
  /** 协议自带的合法示例(供测试与文档) */
  example?: { type: string, payload: Record<string, unknown> }
}

/** 协议文档的运行时视图(JSON 的结构化镜像) */
export interface ProtocolRegistry {
  version: number
  title: string
  description: string
  envelope: { description: string, schema: JsonObjectSchema }
  downlink: Record<string, CommandDef>
  uplink: Record<string, CommandDef>
  agentContext: { description: string, schema: JsonObjectSchema }
  brainEvents: Record<string, { description: string }>
}

/** JSON 导入推断为深层 readonly,统一转为可消费的可变视图 */
export const PROTOCOL = protocolJson as unknown as ProtocolRegistry

// ============================================================================
// 2. JSON Schema → zod 编译器
//    仅覆盖本协议使用到的 JSON Schema 子集(object/string/number/array/enum/minimum/
//    required/additionalProperties)。新增 schema 特性时在此扩展,协议即自动支持。
// ============================================================================

export type JsonSchemaNode
  = | { type: 'object', properties?: Record<string, JsonSchemaNode>, required?: string[], additionalProperties?: boolean, description?: string }
    | { type: 'string', enum?: string[], description?: string }
    | { type: 'number', minimum?: number, enum?: number[], description?: string }
    | { type: 'integer', minimum?: number, enum?: number[], description?: string }
    | { type: 'array', items?: JsonSchemaNode, description?: string }
    | { type: 'boolean', description?: string }

/** 本协议 object schema 的标准形态(用于类型签名) */
export type JsonObjectSchema = Extract<JsonSchemaNode, { type: 'object' }>

/** 把任意 JSON Schema 节点编译为等价的 zod 校验器(带按指令名缓存) */
function compileNode(node: JsonSchemaNode): z.ZodTypeAny {
  switch (node.type) {
    case 'object': {
      const shape: Record<string, z.ZodTypeAny> = {}
      const required = new Set(node.required ?? [])
      for (const [key, sub] of Object.entries(node.properties ?? {})) {
        const field = compileNode(sub)
        shape[key] = required.has(key) ? field : field.optional()
      }
      let obj: z.ZodTypeAny = z.object(shape)
      // additionalProperties:false → 拒绝未知字段(协议所有 schema 均为闭合结构)
      if (node.additionalProperties === false) {
        obj = z.object(shape).strict()
      }
      return obj
    }
    case 'array':
      return z.array(compileNode(node.items ?? { type: 'string' }))
    case 'integer':
    case 'number': {
      if (node.enum && node.enum.length > 0) {
        // 数值枚举(如 dx/dy ∈ {-1,0,1}):zod 的 z.enum 仅支持字符串,故用 literal 联合
        const literals = node.enum.map((v: number) => z.literal(v))
        return literals.length === 1
          ? literals[0]!
          : z.union(literals as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]])
      }
      const base = z.number()
      return node.minimum !== undefined ? base.min(node.minimum) : base
    }
    case 'string': {
      if (node.enum && node.enum.length > 0) {
        return z.enum(node.enum as [string, ...string[]])
      }
      return z.string()
    }
    case 'boolean':
      return z.boolean()
  }
}

/** 已编译 schema 缓存:`${dir}:${name}` → zod,避免每条消息重复编译 */
const schemaCache = new Map<string, z.ZodTypeAny>()

/** 取某条指令 payload 的 zod 校验器;未注册返回 null */
function payloadSchema(name: string, dir: 'downlink' | 'uplink'): z.ZodTypeAny | null {
  const cacheKey = `${dir}:${name}`
  const cached = schemaCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const registry = dir === 'downlink' ? PROTOCOL.downlink : PROTOCOL.uplink
  const def = registry[name]
  if (!def) {
    return null
  }
  const compiled = compileNode(def.inputSchema)
  schemaCache.set(cacheKey, compiled)
  return compiled
}

// ============================================================================
// 3. Wire 类型 — 编译期契约(与 JSON 注册表一一对应)
//    类型派生自 JSON 语义;assertProtocolSync() 在运行时保证键集合不漂移,
//    payload 形状漂移由 CMDParser 的运行时校验 + JSON example 自检兜底。
// ============================================================================

/** 方向(与 Phaser 动画键对应) */
export type Dir = 'up' | 'down' | 'left' | 'right'

/** Agent 行为模式(HUD 徽标展示) */
export type AgentMode = 'idle' | 'wander' | 'approach' | 'talk' | 'wait'

export type AgentStatePayload = { mode: AgentMode, speed: number }
export type AgentMovePayload = { dir: Dir, durationMs: number }
export type AgentFacePayload = { dir: Dir }
export type AgentSayPayload = { text: string, ttlMs: number }
export type DialogOpenPayload = { agentName: string, lines: string[] }

/** 上行:client → server(事实上报,后端只感知不控制玩家) */
export type ClientToServer
  = | { type: 'session.join', payload: { agentId?: string } }
    | { type: 'input.move', payload: { dx: -1 | 0 | 1, dy: -1 | 0 | 1 } }
    | { type: 'input.interact', payload: Record<string, never> }
    | { type: 'player.pos', payload: { x: number, y: number, tileX: number, tileY: number } }
    | { type: 'agent.pos', payload: { x: number, y: number } }

/** 下行:server → client(指令,前端只执行不决策) */
export type ServerToClient
  = | { type: 'session.ready', payload: { agentName: string, spawn: { x: number, y: number } } }
    | { type: 'agent.state', payload: AgentStatePayload }
    | { type: 'agent.move', payload: AgentMovePayload }
    | { type: 'agent.face', payload: AgentFacePayload }
    | { type: 'agent.say', payload: AgentSayPayload }
    | { type: 'dialog.open', payload: DialogOpenPayload }
    | { type: 'dialog.advance', payload: Record<string, never> }
    | { type: 'dialog.close', payload: Record<string, never> }
    | { type: 'error', payload: { code: string, message: string } }

/** wire 类型字面量元组:既是 CMDParser 的已知集合,也是 sync guard 的对照基准 */
export const DOWNLINK_TYPES = [
  'session.ready', 'agent.state', 'agent.move', 'agent.face', 'agent.say',
  'dialog.open', 'dialog.advance', 'dialog.close', 'error',
] as const satisfies readonly string[]

export const UPLINK_TYPES = [
  'session.join', 'input.move', 'input.interact', 'player.pos', 'agent.pos',
] as const satisfies readonly string[]

// ============================================================================
// 4. CMDParser — 指令解析器(消息边界的权威校验入口)
// ============================================================================

export type ParseErrorCode = 'BAD_MESSAGE' | 'UNKNOWN_COMMAND' | 'INVALID_PAYLOAD' | 'FORBIDDEN' | 'USER_UNAUTHORIZED'

export interface ParseError {
  code: ParseErrorCode
  message: string
  /** INVALID_PAYLOAD 时的字段路径(如 "payload.dir") */
  path?: string
}

export type ParseResult<T>
  = | { ok: true, value: T }
    | { ok: false, error: ParseError }

function fail(code: ParseErrorCode, message: string, path?: string): ParseResult<never> {
  return { ok: false, error: { code, message, path } }
}

/** 把 zod 校验失败聚合为单条可读信息 */
function describeZodError(error: z.ZodError): { message: string, path: string } {
  const first = error.issues[0]
  if (!first) {
    return { message: 'payload 校验失败', path: 'payload' }
  }
  const path = first.path.length > 0 ? `payload.${first.path.join('.')}` : 'payload'
  return { message: `${path}: ${first.message}`, path }
}

/** 解析一条 wire 消息:信封校验 → 指令注册校验 → payload schema 校验 */
function parseWire<T>(
  raw: string | unknown,
  dir: 'downlink' | 'uplink',
  known: readonly string[],
): ParseResult<T> {
  // ---- 反序列化(字符串则 JSON.parse,对象直接用) ----
  let msg: unknown
  if (typeof raw === 'string') {
    if (raw.length === 0) {
      return fail('BAD_MESSAGE', '空消息')
    }
    try {
      msg = JSON.parse(raw)
    }
    catch {
      return fail('BAD_MESSAGE', '无法解析的消息')
    }
  }
  else {
    msg = raw
  }

  // ---- 信封:{ type: string, payload: object } ----
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail('BAD_MESSAGE', '消息必须是对象')
  }
  const envelope = msg as Record<string, unknown>
  if (typeof envelope.type !== 'string' || envelope.type.length === 0) {
    return fail('BAD_MESSAGE', '消息缺少 string 类型的 type 字段')
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    return fail('BAD_MESSAGE', '消息缺少 object 类型的 payload 字段')
  }

  // ---- 指令是否注册 ----
  if (!known.includes(envelope.type)) {
    return fail('UNKNOWN_COMMAND', `未知指令 "${envelope.type}"`)
  }
  const schema = payloadSchema(envelope.type, dir)
  if (!schema) {
    return fail('UNKNOWN_COMMAND', `指令 "${envelope.type}" 未注册 payload schema`)
  }

  // ---- payload schema 校验 ----
  const parsed = schema.safeParse(envelope.payload)
  if (!parsed.success) {
    const { message, path } = describeZodError(parsed.error)
    return fail('INVALID_PAYLOAD', message, path)
  }

  return { ok: true, value: { type: envelope.type, payload: parsed.data } as T }
}

export const CMDParser = {
  /** 解析上行消息(client → server),供 ws.ts 边界校验 */
  parseUplink(raw: string | unknown): ParseResult<ClientToServer> {
    return parseWire<ClientToServer>(raw, 'uplink', UPLINK_TYPES)
  },
  /** 解析下行消息(server → client),供前端 client.ts 边界校验 */
  parseDownlink(raw: string | unknown): ParseResult<ServerToClient> {
    return parseWire<ServerToClient>(raw, 'downlink', DOWNLINK_TYPES)
  },
  /** 把解析错误转换为协议的 error 下行指令,供前端 HUD/控制台展示 */
  toErrorCommand(error: ParseError): { type: 'error', payload: { code: string, message: string } } {
    return { type: 'error', payload: { code: error.code, message: error.message } }
  },
}

// ============================================================================
// 5. 协议同步守卫 — 保证 JSON 注册表与 wire 类型不漂移
//    - 键集合:JSON 的每条指令都必须在 DOWNLINK/UPLINK 类型元组中
//    - 自洽性:JSON 自带的 example 必须能通过其 inputSchema 校验
//    开发期(test)显式调用;真实流量再由 CMDParser 兜底。
// ============================================================================

export interface SyncReport {
  downlink: string[]
  uplink: string[]
  /** JSON 有而 wire 类型缺失的指令键(应为空) */
  unsyncedDownlink: string[]
  unsyncedUplink: string[]
  /** example 未通过自身 schema 的指令键(应为空) */
  badExamples: string[]
}

/** 校验 JSON 与 wire 类型的一致性;不一致时抛出,一致时返回报告 */
export function assertProtocolSync(): SyncReport {
  const downlink = Object.keys(PROTOCOL.downlink)
  const uplink = Object.keys(PROTOCOL.uplink)
  const unsyncedDownlink = downlink.filter(k => !(DOWNLINK_TYPES as readonly string[]).includes(k))
  const unsyncedUplink = uplink.filter(k => !(UPLINK_TYPES as readonly string[]).includes(k))

  const badExamples: string[] = []
  for (const name of [...downlink, ...uplink]) {
    const dir = downlink.includes(name) ? 'downlink' : 'uplink'
    const def = (dir === 'downlink' ? PROTOCOL.downlink : PROTOCOL.uplink)[name]
    const example = def?.example?.payload
    if (!example) {
      continue
    }
    const schema = payloadSchema(name, dir)
    if (schema && !schema.safeParse(example).success) {
      badExamples.push(name)
    }
  }

  if (unsyncedDownlink.length || unsyncedUplink.length || badExamples.length) {
    throw new Error(
      `协议不同步: downlink缺类型=${JSON.stringify(unsyncedDownlink)} `
      + `uplink缺类型=${JSON.stringify(unsyncedUplink)} `
      + `example不自洽=${JSON.stringify(badExamples)}`,
    )
  }

  return { downlink, uplink, unsyncedDownlink, unsyncedUplink, badExamples }
}

// ============================================================================
// 6. MCP 工具词表 — agentCallable=true 的 downlink 指令即 Agent 可调用工具集
//    真实 Agent harness(omp / Claude Code)经 MCP 暴露这些工具,
//    工具调用 → session.execDownlink(name, payload) → 校验 → emit → 前端渲染。
// ============================================================================

export interface AgentCallableCommand {
  name: string
  def: CommandDef
}

export interface McpTool {
  /** 工具名 = downlink 指令名 */
  name: string
  /** 工具描述 = 协议 description */
  description: string
  /** 工具参数 schema = 协议 inputSchema(JSON Schema,MCP 标准格式) */
  inputSchema: object
}

/** 所有 Agent 可调用的下行指令(downlink 中 agentCallable=true 者) */
export function agentCallableCommands(): readonly AgentCallableCommand[] {
  return Object.entries(PROTOCOL.downlink)
    .filter(([, def]) => def.agentCallable === true)
    .map(([name, def]) => ({ name, def }))
}

/** 转为 MCP 工具描述符,供 Agent harness 注册工具 */
export function toMcpTools(): McpTool[] {
  return agentCallableCommands().map(({ name, def }) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  }))
}
