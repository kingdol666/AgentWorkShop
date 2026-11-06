/**
 * Session Clone 编排器 —— Channel 多会话（plan 2026-11-06-channel-multi-session-runtime-plan.md S1）。
 *
 * 一个 session = 从频道基础成员克隆出的独立 agent 实例组：
 *   - 每 clone 一个独立 AgentRuntime（既有 agentIndex 按 agentId 键控自动成立）
 *   - 每 clone 独立 mailbox/execLock/omp 进程（会话内串行、会话间并行）
 *   - 记忆按 clone agentId 归属（session 域隔离）；team 域仍按频道共享
 * deps 注入式编排（可单测）；manager 包装提供真实依赖。
 */
import { randomUUID } from 'node:crypto'
import { parseJson } from '../db/database'
import { AppError } from '../../../utils/errors'

export interface SessionCloneMemberRow {
  id: string
  name: string
  harness: string
  role: string
  enabled?: number
  agentKind?: string | null
  configJson?: string
}

export interface SessionCloneDeps {
  channelAgents: {
    listByChannel(channelId: string): SessionCloneMemberRow[]
    create(input: { channelId: string, templateId: null, name: string, harness: string, config: Record<string, unknown>, role: string }): { id: string, name: string, role: string }
  }
  tasks: {
    list(channelId: string): Array<{ id: string, state: string, assigneeId: string | null }>
    cancelTree(taskId: string, by: string, reason: string): unknown[]
  }
  bindings: {
    byAgent(agentId: string): Array<{ nodeId: string, kind: string, mode?: string }>
    bind(agentId: string, nodeId: string, kind: string, mode?: string): unknown
  }
  /** 停用 clone 实例（触发既有 runtime 卸载路径） */
  unloadAgent: (channelId: string, instanceId: string, reason: string) => Promise<void>
  notify?: (channelId: string, payload: { op: 'added' | 'updated' | 'removed', agentId: string, name: string, role: 'lead' | 'worker', harness: string }) => void
}

const SESSION_MARKER = '·session·'
const TERMINAL_TASK_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'])

/** 频道基础成员 = 已启用的 lead/worker（排除项目办公室 leader 与既有 session clone）。 */
function baseMembersOf(deps: SessionCloneDeps, channelId: string) {
  return deps.channelAgents.listByChannel(channelId).filter((m) => {
    if (m.enabled !== 1) return false
    if (m.agentKind === 'project_leader') return false
    if (String(m.name ?? '').includes(SESSION_MARKER)) return false
    return m.role === 'lead' || m.role === 'worker'
  })
}

/** 创建会话：克隆全部基础成员（统一 worker 定位）+ 复制绑定面 + 注册会话。 */
export function createChannelSession(deps: SessionCloneDeps, input: {
  channelId: string
  actorId: string
  title?: string
  sessionRepo: { create(input: { channelId: string, title?: string, memberMap: Record<string, string>, createdBy?: string }): { id: string } }
}): { sessionId: string, title: string, members: Array<{ baseAgentId: string, cloneId: string, name: string, role: string }> } {
  const bases = baseMembersOf(deps, input.channelId)
  if (bases.length === 0) {
    throw new AppError(400, 'NO_BASE_MEMBERS', '频道没有可克隆的基础成员（需要已启用的 lead/worker）')
  }
  const title = (input.title ?? '').trim() || `会话-${randomUUID().slice(0, 6)}`
  const memberMap: Record<string, string> = {}
  const members: Array<{ baseAgentId: string, cloneId: string, name: string, role: string }> = []
  let n = 0
  for (const base of bases) {
    n += 1
    const cloneName = `${base.name}${SESSION_MARKER}${n}`
    const config = parseJson<Record<string, unknown>>(base.configJson ?? '{}', {})
    const created = deps.channelAgents.create({
      channelId: input.channelId,
      templateId: null,
      name: cloneName,
      harness: base.harness,
      config,
      // clone 统一 worker 定位：会话=执行单元；基础 lead 保持频道协调者身份不变
      role: 'worker',
    })
    memberMap[base.id] = created.id
    members.push({ baseAgentId: base.id, cloneId: created.id, name: cloneName, role: 'worker' })
    // 复制基础成员的节点绑定面（daq 读/dcw 写/配方/产线配方管理权）
    for (const b of deps.bindings.byAgent(base.id)) {
      deps.bindings.bind(created.id, b.nodeId, b.kind, b.mode)
    }
    deps.notify?.(input.channelId, { op: 'added', agentId: created.id, name: cloneName, role: 'worker', harness: base.harness })
  }
  const session = input.sessionRepo.create({
    channelId: input.channelId,
    title,
    memberMap,
    createdBy: input.actorId,
  })
  return { sessionId: session.id, title, members }
}

/** 关闭会话：在飞任务按树取消 + clone 实例停用（runtime 卸载）+ 会话 closed。 */
export async function closeChannelSession(deps: SessionCloneDeps, input: {
  channelId: string
  sessionId: string
  actorId: string
  reason?: string
  sessionRepo: { findById(id: string): { status: string, memberMapJson: string } | undefined, close(id: string): boolean }
}): Promise<{ canceledTasks: number, clones: string[] }> {
  const session = input.sessionRepo.findById(input.sessionId)
  if (!session) throw new AppError(404, 'NOT_FOUND', `会话不存在: ${input.sessionId}`)
  // 幂等语义：已关闭会话重复 close 不再重复取消（cancelTree 二次调用对已终态任务无害，
  // 但会让审计/返回值失真）。
  if (session.status === 'closed') return { canceledTasks: 0, clones: [] }
  const reason = input.reason?.trim() || 'SESSION_CLOSED'
  const memberMap = parseJson<Record<string, string>>(session.memberMapJson, {})
  const clones = Object.values(memberMap)
  let canceledTasks = 0
  for (const cloneId of clones) {
    for (const t of deps.tasks.list(input.channelId)) {
      if (t.assigneeId !== cloneId || TERMINAL_TASK_STATES.has(t.state)) continue
      deps.tasks.cancelTree(t.id, input.actorId, reason)
      canceledTasks += 1
    }
    await deps.unloadAgent(input.channelId, cloneId, reason)
  }
  input.sessionRepo.close(input.sessionId)
  return { canceledTasks, clones }
}
