/**
 * Task Instance Channel 编排器 —— 项目任务的专属执行实例
 * （plan 2026-11-07-project-task-session-plan.md P1）。
 *
 * 为什么是「任务专属 Channel」而不是「共享 Channel + 每任务一 session」：
 *   1. 根任务 FIFO 是**按 Channel** 的（TaskEngine.activeRootOf(channelId) 只认最老
 *      非终态根）——共享 Channel 上多任务必然串行，会话克隆无法绕过这一层；
 *   2. 任务专属 Channel 天然拥有独立 SchedulerLoop / 根队列 / workspace / 成员
 *      runtime，两个任务可真正并行；
 *   3. agentProjectContext 依赖 channel 的项目绑定，任务 Channel 必须绑定项目
 *      （binding_type='task_instance'），这样实例成员才有 channel_lead 工具面
 *      （project_submit_result 等）。
 *
 * 隔离语义：模板 Channel = 装配蓝图（成员配置/场景/LLM/节点绑定面）；
 * 任务 Channel = 该任务的实例（新 Channel 行 + 新成员实例 id = 新 runtime 对象）。
 * 会话行（instance_kind='task'）记录 templateMemberId → 实例成员 id 的真实映射，
 * 供项目观测与前端把「任务 ↔ 会话」关联起来。
 *
 * deps 注入式（可单测）；manager 包装提供真实依赖。
 */
import { randomUUID } from 'node:crypto'
import { parseJson } from '../db/database'
import { AppError } from '../../../utils/errors'
import { inheritChannelProfile } from './task-channel-profile'

export const TASK_INSTANCE_MARKER = '·任务·'
const EXCLUDED_NAME_MARKERS = [TASK_INSTANCE_MARKER, '·session·']

export interface TaskInstanceMemberRow {
  id: string
  name: string
  harness: string
  role: string
  enabled?: number
  agentKind?: string | null
  configJson?: string
}

export interface TaskInstanceDeps {
  channels: {
    findById(channelId: string): { id: string, name: string, scenarioPrompt: string, llmJson: string, ownerUserId: string | null } | undefined
  }
  channelAgents: {
    listByChannel(channelId: string): TaskInstanceMemberRow[]
    create(input: { channelId: string, templateId: null, name: string, harness: string, config: Record<string, unknown>, role: string }): { id: string, name: string, role: string }
  }
  bindings: {
    byAgent(agentId: string): Array<{ nodeId: string, kind: string, mode?: string }>
    bind(agentId: string, nodeId: string, kind: string, mode?: string): unknown
  }
  sessions: {
    create(input: {
      channelId: string
      title?: string
      memberMap: Record<string, string>
      createdBy?: string
      projectId?: string | null
      projectWorkItemId?: string | null
      createdByKind?: 'user' | 'project'
      instanceKind?: 'manual' | 'task'
    }): { id: string }
  }
  /** 建 Channel（含 lead 内联模板实例）+ owner 成员行 + workspace 目录 */
  createChannel(input: {
    name: string
    description?: string
    scenarioPrompt?: string
    llm?: { provider?: string, model?: string, effort?: string } | null
    ownerUserId?: string | null
    leadAgent: { name: string, harness: string, config?: Record<string, unknown> }
  }): Promise<{ channelId: string, leadAgentId?: string, workspace: string }>
  notify?: (channelId: string, payload: { op: 'added', agentId: string, name: string, role: 'lead' | 'worker', harness: string }) => void
}

/** 模板频道的可克隆基础成员（排除办公室 leader 与既有一/任务/会话实例）。 */
export function templateMembersOf(deps: TaskInstanceDeps, templateChannelId: string): TaskInstanceMemberRow[] {
  return deps.channelAgents.listByChannel(templateChannelId).filter((m) => {
    if (m.enabled !== 1) return false
    if (m.agentKind === 'project_leader') return false
    const name = String(m.name ?? '')
    if (EXCLUDED_NAME_MARKERS.some(marker => name.includes(marker))) return false
    return m.role === 'lead' || m.role === 'worker'
  })
}

/**
 * 为项目任务创建专属 Channel + 实例成员 + 会话行。
 * 返回实例 Channel 与其 lead（root 任务的 assignee）。
 */
export async function createTaskInstanceChannel(deps: TaskInstanceDeps, input: {
  projectId: string
  workItemId: string
  templateChannelId: string
  title: string
  actorId: string
}): Promise<{
  sessionId: string
  channelId: string
  leadAgentId: string
  members: Array<{ templateAgentId: string, instanceId: string, name: string, role: string }>
}> {
  const template = deps.channels.findById(input.templateChannelId)
  if (!template) throw new AppError(404, 'NOT_FOUND', `模板 Channel 不存在: ${input.templateChannelId}`)
  const bases = templateMembersOf(deps, input.templateChannelId)
  const lead = bases.find(m => m.role === 'lead')
  if (!lead) throw new AppError(409, 'CHANNEL_NO_LEAD', '模板 Channel 没有可克隆的 lead，无法建立任务实例')
  const short = randomUUID().slice(0, 4)
  const memberSuffix = `${TASK_INSTANCE_MARKER}${short}`
  const instanceName = `${template.name} · 任务 ${short}`
  const llm = (() => {
    try {
      const parsed = parseJson<Record<string, unknown>>(template.llmJson || '{}', {})
      return Object.keys(parsed).length > 0 ? parsed as { provider?: string, model?: string, effort?: string } : null
    }
    catch {
      return null
    }
  })()
  // 1) 建实例 Channel（含 lead 内联模板实例；workspace 独立 → 任务间文件系统隔离）
  const created = await deps.createChannel({
    name: instanceName,
    description: `任务实例：${input.title}`,
    scenarioPrompt: template.scenarioPrompt,
    llm,
    ownerUserId: template.ownerUserId,
    leadAgent: {
      name: `${lead.name}${memberSuffix}`,
      harness: lead.harness,
      config: parseJson<Record<string, unknown>>(lead.configJson ?? '{}', {}),
    },
  })
  if (!created.leadAgentId) throw new AppError(500, 'TASK_INSTANCE_NO_LEAD', '任务实例 Channel 装配 lead 失败')
  const memberMap: Record<string, string> = { [lead.id]: created.leadAgentId }
  const members: Array<{ templateAgentId: string, instanceId: string, name: string, role: string }> = [
    { templateAgentId: lead.id, instanceId: created.leadAgentId, name: `${lead.name}${memberSuffix}`, role: 'lead' },
  ]
  // 2) 复制 lead 的节点绑定面
  for (const b of deps.bindings.byAgent(lead.id)) deps.bindings.bind(created.leadAgentId, b.nodeId, b.kind, b.mode)
  // 3) 克隆其余成员（worker 身份）+ 绑定面
  for (const base of bases) {
    if (base.role === 'lead') continue
    const inst = deps.channelAgents.create({
      channelId: created.channelId,
      templateId: null,
      name: `${base.name}${memberSuffix}`,
      harness: base.harness,
      config: parseJson<Record<string, unknown>>(base.configJson ?? '{}', {}),
      role: 'worker',
    })
    memberMap[base.id] = inst.id
    members.push({ templateAgentId: base.id, instanceId: inst.id, name: `${base.name}${memberSuffix}`, role: 'worker' })
    for (const b of deps.bindings.byAgent(base.id)) deps.bindings.bind(inst.id, b.nodeId, b.kind, b.mode)
    deps.notify?.(created.channelId, { op: 'added', agentId: inst.id, name: inst.name, role: 'worker', harness: base.harness })
  }
  // 4) 会话行（任务实例上下文；templateMemberId → 实例成员 id）
  const session = deps.sessions.create({
    channelId: created.channelId,
    title: `任务：${input.title}`,
    memberMap,
    createdBy: input.actorId,
    projectId: input.projectId,
    projectWorkItemId: input.workItemId,
    createdByKind: 'project',
    instanceKind: 'task',
  })
  // 5) RSI WP-D5:继承母频道 AML profile（降档 + 不继承模型绑定；legacy 不写）
  inheritChannelProfile(input.templateChannelId, created.channelId)
  return { sessionId: session.id, channelId: created.channelId, leadAgentId: created.leadAgentId, members }
}
