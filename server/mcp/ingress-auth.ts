/**
 * MCP Streamable HTTP ingress 身份与资源范围判定（纯逻辑，便于单测）。
 *
 * 背景：/api/mcp/workshop 的 stateful transport 会话原先只保存 transport，
 * 不绑定请求主体；工具 handler 各自解析 Bearer token。这样同一 sessionId
 * 可以被另一 Agent 复用，已停用成员也可能继续用旧会话/旧 token。
 *
 * 本模块把两件事收敛为可测试判定：
 *  1. 每个 HTTP 请求都重新解析当前有效 Agent（成员 enabled + Channel enabled），
 *     并与会话初始化时绑定的主体比对；
 *  2. 数字孪生设备只对「全局设备 / 调用者 Channel 所在工作区 / 已绑定给调用者」
 *     可见，且 Agent 只能把设备绑定给自己。
 *
 * 真正的执行入口仍由 workshop-server 的 manager / tool handler 复核；这里不做网络访问。
 */
import type { AgentInfo } from '../services/workshop/agents/agent-interface'
import type { DeviceTwin } from '../services/workshop/assets/device-twin.repo'
import { AppError } from '../utils/errors'

/** 设备可见性所需的最小设备字段（避免测试构造完整 DeviceTwin） */
type DeviceScopeInput = Pick<DeviceTwin, 'workspaceId' | 'boundAgentId'>

/** Agent 在 MCP ingress 中的可信身份（只取判定需要的字段） */
export interface IngressPrincipal {
  id: string
  channelId: string
  role: 'lead' | 'worker'
}

/** 调用者可访问的设备范围：全局设备 + 挂载其 Channel 的工作区 + 绑定给自身的设备 */
export interface DeviceAccessScope {
  agentId: string
  channelId: string
  workspaceIds: string[]
}

/** manager 的最小能力面（生产实现位于 runtime/manager/host-tools.ts） */
export interface IngressAuthManager {
  /** 新增的严格解析：token 有效且成员/Channel 均启用才返回；旧 manager 可退回 findByToken */
  findActiveAgentByToken?(token: string): AgentInfo | undefined
  findByToken(token: string): AgentInfo | undefined
  deviceAccessScopeOf?(agentId: string): DeviceAccessScope | null
}

/** 从 Authorization 头取 Bearer token；缺失/格式不符返回 null */
export function bearerTokenOf(header: string | null | undefined): string | null {
  if (!header) return null
  const matched = header.trim().match(/^Bearer\s+(.+)$/i)
  return matched?.[1]?.trim() || null
}

/**
 * 解析当前请求主体。每个请求（含复用 session 的 tools/list、tools/call、GET SSE、
 * DELETE）都必须携带有效 Bearer token；停用成员/Channel 立刻失效。
 */
export function resolveIngressPrincipal(manager: IngressAuthManager, authorization: string | null | undefined): AgentInfo {
  const token = bearerTokenOf(authorization)
  if (!token) {
    throw new AppError(401, 'UNAUTHORIZED', 'MCP HTTP 需要 Agent Bearer token')
  }
  const agent = manager.findActiveAgentByToken
    ? manager.findActiveAgentByToken(token)
    : manager.findByToken(token)
  if (!agent) {
    throw new AppError(401, 'UNAUTHORIZED', 'Agent token 无效、成员已停用或其 Channel 已停用')
  }
  return agent
}

/** 会话主体不可切换：新请求解析出的 Agent 必须与初始化时一致 */
export function assertSessionPrincipal(boundAgentId: string, currentAgentId: string): void {
  if (boundAgentId !== currentAgentId) {
    throw new AppError(403, 'MCP_SESSION_PRINCIPAL_MISMATCH', 'FORBIDDEN: MCP 会话不得切换请求主体')
  }
}

/** 设备是否在调用者范围内（纯判定；不改变仓库状态） */
export function deviceVisibleTo(device: DeviceScopeInput, scope: DeviceAccessScope): boolean {
  if (device.workspaceId === '') return true
  if (scope.workspaceIds.includes(device.workspaceId)) return true
  return device.boundAgentId === scope.agentId
}

/** 读取设备前的范围校验；不可见时抛 403，不返回设备内容 */
export function assertDeviceVisible(device: DeviceScopeInput, scope: DeviceAccessScope): void {
  if (!deviceVisibleTo(device, scope)) {
    throw new AppError(403, 'DEVICE_SCOPE_DENIED', 'FORBIDDEN: 设备不在调用者可访问范围')
  }
}

/**
 * 绑定设备前的校验：
 *  - 只允许把设备绑定给自己（防止 Agent A 把设备交给 Agent B）；
 *  - 设备必须在调用者范围内；
 *  - 已被其他 Agent 绑定的设备不得抢占。
 */
export function assertCanBindDevice(device: DeviceScopeInput, scope: DeviceAccessScope, targetAgentId: string): void {
  if (targetAgentId !== scope.agentId) {
    throw new AppError(403, 'DEVICE_BIND_FORBIDDEN', 'FORBIDDEN: Agent 只能把设备绑定给自己')
  }
  assertDeviceVisible(device, scope)
  if (device.boundAgentId && device.boundAgentId !== scope.agentId) {
    throw new AppError(403, 'DEVICE_BIND_FORBIDDEN', 'FORBIDDEN: 设备已绑定给其他 Agent')
  }
}

/** 设备工具使用的默认空范围（manager 未提供 scope 方法时的最小权限兜底） */
export function emptyDeviceScope(principal: Pick<AgentInfo, 'id' | 'channelId'>): DeviceAccessScope {
  return { agentId: principal.id, channelId: principal.channelId, workspaceIds: [] }
}
