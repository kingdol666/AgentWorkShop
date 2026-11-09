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
  /**
   * 强制摘除 clone 运行时（会话关闭专用）：绕过 unloadAgent 的 idle/pending 闸门，
   * 先摘索引再停机（stopAndDetach 语义）——防「忙 clone + 遗留 pending 消息」僵尸运行时。
   * 缺省时回退 unloadAgent（兼容测试替身）。
   */
  stopAgentRuntime?: (channelId: string, instanceId: string, reason: string) => Promise<void>
  /** 中止 clone 正在执行的指定任务（cancelTree 后立刻打断 LLM 回合，不等回合自然结束）。 */
  abortTask?: (channelId: string, instanceId: string, taskId: string) => void
  /** 停用 clone 成员行（enabled=0）：关闭的会话不得再被寻址/惰性重装配。 */
  disableAgent?: (channelId: string, instanceId: string) => void
  notify?: (channelId: string, payload: { op: 'added' | 'updated' | 'removed', agentId: string, name: string, role: 'lead' | 'worker', harness: string }) => void
}

export const SESSION_MARKER = '·session·'
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
  // clone 名必须**跨会话唯一**:旧实现每个会话从 1 重计,并存会话里会同时存在
  // `Alice·session·1` × N;resolveMemberRef 按名字精确匹配取第一个(created_at ASC),
  // LLM 按名册寻址会恒投到最早那个会话的 clone。
  const existing = deps.channelAgents.listByChannel(input.channelId)
  const nextSeqOf = (baseName: string): number => {
    const prefix = `${baseName}${SESSION_MARKER}`
    let max = 0
    for (const m of existing) {
      const name = String(m.name ?? '')
      if (!name.startsWith(prefix)) continue
      const seq = Number(name.slice(prefix.length))
      if (Number.isInteger(seq) && seq > max) max = seq
    }
    return max + 1
  }
  const usedSeq = new Set<number>()
  for (const base of bases) {
    let seq = nextSeqOf(base.name)
    while (usedSeq.has(seq)) seq += 1
    usedSeq.add(seq)
    const cloneName = `${base.name}${SESSION_MARKER}${seq}`
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
      const canceled = deps.tasks.cancelTree(t.id, input.actorId, reason) as
        | Array<{ id?: string, assigneeId?: string | null }>
        | undefined
      canceledTasks += 1
      // 取消只改任务状态；正在跑的 LLM 回合必须显式打断，否则 clone 会继续烧预算到回合结束。
      // 子任务可能指派给同频道的其他 clone，按各自 assignee 的运行时中止。
      const abortIds = Array.isArray(canceled) && canceled.length > 0
        ? canceled.map(c => ({ taskId: String(c?.id ?? ''), agentId: String(c?.assigneeId ?? cloneId) }))
        : [{ taskId: t.id, agentId: cloneId }]
      for (const a of abortIds) {
        if (a.taskId) deps.abortTask?.(input.channelId, a.agentId, a.taskId)
      }
    }
    // 关闭的会话不得再被寻址：先停用成员行，再强制摘除运行时。
    // 会话关闭用「强制摘除」而非带闸门的 unloadAgent —— 取消在飞任务后忙 clone 会
    // 立刻卸载；遗留的 pending assign 消息不再把运行时钉住（会话已关闭，不应再消费）。
    deps.disableAgent?.(input.channelId, cloneId)
    if (deps.stopAgentRuntime) await deps.stopAgentRuntime(input.channelId, cloneId, reason)
    else await deps.unloadAgent(input.channelId, cloneId, reason)
  }
  input.sessionRepo.close(input.sessionId)
  return { canceledTasks, clones }
}

/**
 * 反向解析成员当前所属的 active 会话（memberMap 的 value 命中成员实例 id）。
 *
 * 用于运行时写入面补 session 戳（如 omp 压缩摘要）。project 会话是
 * 「办公室 lead → 自身」的恒等映射（projects/service.ts 创建），不属于可复用
 * 会话维度，排除以免把项目办公室的摘要误盖成会话戳；manual/task 会话的
 * memberMap 值都是真实克隆实例 id，按实例反查即可。
 */
export function activeSessionIdOfMember(
  sessions: Array<{ id: string, status: string, instanceKind: string, memberMapJson: string }>,
  memberId: string,
): string | null {
  for (const s of sessions) {
    if (s.status !== 'active' || s.instanceKind === 'project') continue
    const map = parseJson<Record<string, string>>(s.memberMapJson, {})
    if (Object.values(map).includes(memberId)) return s.id
  }
  return null
}
