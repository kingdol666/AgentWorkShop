/**
 * 受管外部 MCP 服务类型。
 *
 * 安全边界：
 *  - 只支持管理员登记的 Streamable HTTP 服务；凭据仅保存 AW_MCP_* 环境变量引用；
 *  - 发现结果只是元数据；工具必须经管理员审阅且仅 shared-safe 只读工具可批准；
 *  - 调用前必须再次校验 enabled/review/schema/owner，拒绝时不得访问上游。
 */

export type McpReviewStatus = 'pending' | 'approved' | 'rejected'
export type McpToolClassification = 'read' | 'write'
export type McpDataSharing = 'shared-safe' | 'project-private' | 'unknown'

export interface McpToolRecord {
  /** 对 Agent/工具面暴露的稳定名称（mcp_<server>_<tool>） */
  id: string
  serverId: string
  upstreamName: string
  exposedName: string
  description: string
  inputSchema: Record<string, unknown>
  /** canonical JSON sha256；schema 变化即需重新审阅 */
  schemaHash: string
  reviewStatus: McpReviewStatus
  classification: McpToolClassification
  reviewedAt?: string
  reviewedBy?: string
}

export interface McpServerManifest {
  id: string
  label: string
  transport: 'streamable-http'
  /** 仅 https；不允许 URL 内嵌凭据 */
  endpoint: string
  /** AW_MCP_* 环境变量名；绝不保存值 */
  credentialRef?: string
  /** endpoint/credential 变化时 +1，使既有审阅失效 */
  credentialGeneration: number
  enabled: boolean
  protocolPolicy: 'auto'
  /** 无 listChanged 通知时，超过该时长必须重新发现 */
  maxDiscoveryAgeMs: number
  /** 数据域：只有 shared-safe 才允许发布给 Agent（首版保守限制） */
  dataSharing: McpDataSharing
  tools: McpToolRecord[]
  createdAt: string
  updatedAt: string
  lastDiscoveredAt?: string
  lastProtocolEra?: string
  lastError?: string
}

export interface McpDiscoveredTool {
  upstreamName: string
  description: string
  inputSchema: Record<string, unknown>
  schemaHash: string
}

export interface McpDiscoverySnapshot {
  tools: McpDiscoveredTool[]
  protocolEra?: string
  serverInfo?: unknown
}

/** 可注入的客户端能力（测试用 fake；生产实现见 client.ts） */
export interface McpConnection {
  discover(): Promise<McpDiscoverySnapshot>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

export interface McpCallContext {
  agentId: string
  channelId?: string
  /** 调用时授权：返回 false 时 broker 不发任何上游请求 */
  authorize: (input: { serverId: string, tool: McpToolRecord }) => boolean | Promise<boolean>
  /** 审计 sink（生产传 recordOps；不得记录 secret/无界响应） */
  audit?: (entry: {
    action: string
    agentId: string
    serverId: string
    toolId: string
    outcome: 'ok' | 'denied' | 'error'
    durationMs: number
    requestId: string
    detail?: string
  }) => void
}

export interface McpCallResult {
  text: string
  isError?: boolean
  requestId: string
}
