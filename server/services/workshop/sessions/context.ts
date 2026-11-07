/**
 * Session Context —— 平台侧确定性上下文装配。
 *
 * Session 是上下文单元，harness 会话只是执行 lane。本模块只读任务/消息/项目事实，
 * 生成有界 brief / summary / history；不调用 LLM，不反向驱动任务状态。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelSessionRow } from '../db/channel-session.repo'
import type { Part } from '../types/a2a'
import { parseJson } from '../db/database'

export interface SessionTaskBrief {
  id: string
  title: string
  state: string
  progress: number
  assigneeId: string
}

export interface SessionBrief {
  sessionId: string
  kind: 'manual' | 'task' | 'project'
  title: string
  status: string
  channelId: string
  channelName: string
  projectId: string | null
  projectName: string | null
  workItemId: string | null
  workItemTitle: string | null
  objective: string
  rootTaskId: string | null
  currentTask: SessionTaskBrief | null
  tasks: SessionTaskBrief[]
  deliverables: Array<{ name: string, status: string, artifactId: string | null, bytes: number }>
  recentMessages: Array<{ role: string, name: string, text: string, at: string }>
  decisions: Array<{ id: string, text: string, state: string, at: string }>
  openQuestions: string[]
  nextStep: string
  lastActiveAt: string | null
  updatedAt: string
}

export interface SessionCatalogItem {
  id: string
  kind: 'manual' | 'task' | 'project'
  title: string
  status: string
  channelId: string
  projectId: string | null
  workItemId: string | null
  summary: string
  currentTask: string | null
  lastActiveAt: string | null
}

export interface SessionHistoryItem {
  type: 'message' | 'task'
  id: string
  at: string
  role?: string
  name?: string
  text?: string
  taskId?: string
  state?: string
  progress?: number
}

function textOfParts(partsJson: string): string {
  const parts = parseJson<Part[]>(partsJson, [])
  return parts
    .map(p => ('text' in p ? p.text : 'data' in p ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function short(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function sessionKind(row: ChannelSessionRow): SessionBrief['kind'] {
  if (row.instanceKind === 'project') return 'project'
  if (row.instanceKind === 'task') return 'task'
  return 'manual'
}

export class SessionContextService {
  constructor(
    private db: DatabaseSync,
    private sessions: {
      findById(id: string): ChannelSessionRow | undefined
      listByChannel(channelId: string): ChannelSessionRow[]
      listByProject(projectId: string): ChannelSessionRow[]
      updateBrief(id: string, input: { summary?: string, briefJson?: string, lastActiveAt?: string | null }): boolean
      touch(id: string, at?: string): void
    },
  ) {}

  /** 构建 brief（纯读）；refresh=true 时回写 summary/brief_json/last_active_at。 */
  buildBrief(sessionId: string, opts: { refresh?: boolean } = {}): SessionBrief | null {
    const row = this.sessions.findById(sessionId)
    if (!row) return null
    const brief = this.assemble(row)
    if (opts.refresh) {
      this.sessions.updateBrief(sessionId, {
        summary: this.toSummary(brief),
        briefJson: JSON.stringify(brief),
        lastActiveAt: brief.lastActiveAt,
      })
    }
    return brief
  }

  /** 读取已缓存 brief；缓存缺失时惰性构建。 */
  briefOf(sessionId: string): SessionBrief | null {
    const row = this.sessions.findById(sessionId)
    if (!row) return null
    const cached = parseJson<SessionBrief | null>(row.briefJson, null)
    if (cached && cached.sessionId === sessionId) {
      const age = Date.now() - Date.parse(cached.updatedAt)
      if (Number.isFinite(age) && age >= 0 && age < 5000) return cached
    }
    return this.buildBrief(sessionId, { refresh: true })
  }

  /** 刷新（任务/消息/关闭事件调用）。 */
  refresh(sessionId: string): SessionBrief | null {
    return this.buildBrief(sessionId, { refresh: true })
  }

  /** Channel 会话目录（active 优先，最多 limit 条）。 */
  catalog(channelId: string, limit = 20): SessionCatalogItem[] {
    return this.sessions.listByChannel(channelId)
      .slice()
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1
        return String(b.lastActiveAt ?? b.createdAt).localeCompare(String(a.lastActiveAt ?? a.createdAt))
      })
      .slice(0, limit)
      .map((row) => {
        const brief = this.briefOf(row.id)
        return {
          id: row.id,
          kind: sessionKind(row),
          title: row.title,
          status: row.status,
          channelId: row.channelId,
          projectId: row.projectId,
          workItemId: row.projectWorkItemId,
          summary: row.summary || (brief ? this.toSummary(brief) : ''),
          currentTask: brief?.currentTask?.title ?? null,
          lastActiveAt: row.lastActiveAt,
        }
      })
  }

  /** Channel lead 的目录文本（有界；不注入其他 session 原文）。 */
  catalogText(channelId: string, limit = 20): string {
    const items = this.catalog(channelId, limit)
    if (items.length === 0) return ''
    return [
      '## Sessions in this Channel (catalog only)',
      ...items.map(i => `- ${i.status === 'active' ? 'ACTIVE' : i.status.toUpperCase()} ${i.id.slice(0, 12)} | ${i.kind} | ${short(i.title, 40)} | ${short(i.summary, 120)}${i.currentTask ? ` | current: ${short(i.currentTask, 60)}` : ''}`),
      '以上只是目录；只有当前 session 的 brief 是权威上下文。需要其他 session 细节时使用 session API/工具，不要凭记忆推断。',
    ].join('\n')
  }

  /** Project 的会话目录（project session + task sessions）。 */
  projectCatalog(projectId: string, limit = 50): SessionCatalogItem[] {
    return this.sessions.listByProject(projectId)
      .slice(0, limit)
      .map((row) => {
        const brief = this.briefOf(row.id)
        return {
          id: row.id,
          kind: sessionKind(row),
          title: row.title,
          status: row.status,
          channelId: row.channelId,
          projectId: row.projectId,
          workItemId: row.projectWorkItemId,
          summary: row.summary || (brief ? this.toSummary(brief) : ''),
          currentTask: brief?.currentTask?.title ?? null,
          lastActiveAt: row.lastActiveAt,
        }
      })
  }

  /** 有界 history：messages(session) + tasks(session) 合并。 */
  history(sessionId: string, limit = 80): SessionHistoryItem[] {
    const row = this.sessions.findById(sessionId)
    if (!row) return []
    const taskFilter = row.instanceKind === 'task' || row.instanceKind === 'project'
      ? 'session_id = ? OR (session_id IS NULL AND channel_id = ?)'
      : 'session_id = ?'
    const args = taskFilter.includes('channel_id') ? [sessionId, row.channelId, limit] : [sessionId, limit]
    const tasks = this.db.prepare(
      `SELECT id, title, state, progress, updated_at AS at FROM tasks
       WHERE ${taskFilter} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...args) as Array<{ id: string, title: string, state: string, progress: number, at: string }>
    const messages = this.db.prepare(
      `SELECT id, role, from_agent_id AS fromAgentId, to_agent_id AS toAgentId,
              parts_json AS partsJson, created_at AS at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(sessionId, limit) as Array<{ id: string, role: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, at: string }>
    const history: SessionHistoryItem[] = [
      ...tasks.map(t => ({
        type: 'task' as const,
        id: t.id,
        at: t.at,
        taskId: t.id,
        text: t.title,
        state: t.state,
        progress: Number(t.progress ?? 0),
      })),
      ...messages.map(m => ({
        type: 'message' as const,
        id: m.id,
        at: m.at,
        role: m.role,
        name: m.fromAgentId ?? m.toAgentId ?? 'system',
        text: textOfParts(m.partsJson),
      })),
    ]
    return history
      .filter(h => Boolean(h.text))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-limit)
  }

  /** 当前 channel 的 active session（任务实例/项目办公室优先）。 */
  activeForChannel(channelId: string): ChannelSessionRow | undefined {
    return this.sessions.listByChannel(channelId).find(s => s.status === 'active')
  }

  private assemble(row: ChannelSessionRow): SessionBrief {
    const channel = this.db.prepare('SELECT name FROM channels WHERE id = ?').get(row.channelId) as { name: string } | undefined
    const project = row.projectId
      ? this.db.prepare('SELECT name, objective FROM projects WHERE id = ?').get(row.projectId) as { name: string, objective: string } | undefined
      : undefined
    const workItem = row.projectWorkItemId
      ? this.db.prepare('SELECT title, brief FROM project_work_items WHERE id = ?').get(row.projectWorkItemId) as { title: string, brief: string } | undefined
      : undefined
    const taskFilter = row.instanceKind === 'task' || row.instanceKind === 'project'
      ? 'session_id = ? OR (session_id IS NULL AND channel_id = ?)'
      : 'session_id = ?'
    const taskArgs = taskFilter.includes('channel_id') ? [row.id, row.channelId] : [row.id]
    const taskRows = this.db.prepare(
      `SELECT id, title, state, progress, assignee_id AS assigneeId, artifacts_json AS artifactsJson, updated_at AS updatedAt
       FROM tasks WHERE ${taskFilter} ORDER BY created_at ASC`,
    ).all(...taskArgs) as Array<{
      id: string
      title: string
      state: string
      progress: number
      assigneeId: string
      artifactsJson: string
      updatedAt: string
    }>
    const tasks: SessionTaskBrief[] = taskRows.map(t => ({
      id: t.id,
      title: t.title,
      state: t.state,
      progress: Number(t.progress ?? 0),
      assigneeId: t.assigneeId,
    }))
    // Project session 的上下文是「项目工作项/交付物」，不是办公室 Channel 的 tasks。
    const projectTasks: SessionTaskBrief[] = row.instanceKind === 'project' && row.projectId
      ? (this.db.prepare(
          `SELECT id, title, state, 0 AS progress
           FROM project_work_items WHERE project_id = ? ORDER BY created_at ASC`,
        ).all(row.projectId) as Array<{ id: string, title: string, state: string, progress: number }>)
          .map(w => ({ id: w.id, title: w.title, state: w.state, progress: Number(w.progress ?? 0), assigneeId: '' }))
      : []
    const scopeTasks = projectTasks.length > 0 ? projectTasks : tasks
    const currentTask = scopeTasks.find(t => !['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'].includes(t.state))
      ?? scopeTasks[scopeTasks.length - 1]
      ?? null
    const projectDeliverables = row.instanceKind === 'project' && row.projectId
      ? (this.db.prepare(
          `SELECT name, status FROM project_deliverables WHERE project_id = ? ORDER BY created_at ASC LIMIT 12`,
        ).all(row.projectId) as Array<{ name: string, status: string }>)
          .map(d => ({ name: d.name, status: d.status, artifactId: null, bytes: 0 }))
      : []
    const deliverables = projectDeliverables.length > 0
      ? projectDeliverables
      : taskRows.flatMap((t) => {
          const artifacts = parseJson<Array<{ artifactId?: string, name?: string, parts?: Part[] }>>(t.artifactsJson, [])
          return artifacts.map(a => ({
            name: a.name ?? a.artifactId ?? 'artifact',
            status: t.state === 'COMPLETED' ? 'approved' : t.state.toLowerCase(),
            artifactId: a.artifactId ?? null,
            bytes: (a.parts ?? []).reduce((n, p) => n + ('text' in p ? p.text.length : 0), 0),
          }))
        }).slice(-8)
    const messageFilter = row.instanceKind === 'task' || row.instanceKind === 'project'
      ? 'session_id = ? OR (session_id IS NULL AND channel_id = ?)'
      : 'session_id = ?'
    const messageArgs = messageFilter.includes('channel_id') ? [row.id, row.channelId, 12] : [row.id, 12]
    const messages = this.db.prepare(
      `SELECT role, from_agent_id AS fromAgentId, to_agent_id AS toAgentId, parts_json AS partsJson, created_at AS at
       FROM messages WHERE ${messageFilter} ORDER BY created_at DESC LIMIT ?`,
    ).all(...messageArgs) as Array<{ role: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, at: string }>
    const recentMessages = messages.reverse().map(m => ({
      role: m.role === 'ROLE_USER' ? 'user' : 'agent',
      name: m.fromAgentId ?? m.toAgentId ?? 'system',
      text: short(textOfParts(m.partsJson), 240),
      at: m.at,
    })).filter(m => m.text)
    const decisions = row.projectId
      ? (this.db.prepare(
          `SELECT id, decision_type AS decisionType, state, outcome, created_at AS at
           FROM project_decisions WHERE project_id = ? ORDER BY seq DESC LIMIT 5`,
        ).all(row.projectId) as Array<{ id: string, decisionType: string, state: string, outcome: string, at: string }>)
          .map(d => ({ id: d.id, text: short(d.outcome || d.decisionType, 160), state: d.state, at: d.at }))
      : []
    const openQuestions = [
      ...scopeTasks.filter(t => ['BLOCKED', 'REWORK'].includes(t.state)).map(t => `${t.title} (${t.state})`),
      ...(row.projectId
        ? (this.db.prepare(
            `SELECT kind, subject_id AS subjectId FROM project_approvals
             WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 5`,
          ).all(row.projectId) as Array<{ kind: string, subjectId: string }>)
            .map(a => `待审批 ${a.kind} ${a.subjectId.slice(0, 8)}`)
        : []),
    ].slice(0, 6)
    const lastActiveAt = [row.lastActiveAt, ...taskRows.map(t => t.updatedAt), ...messages.map(m => m.at)]
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .sort()
      .pop() ?? row.createdAt
    return {
      sessionId: row.id,
      kind: sessionKind(row),
      title: row.title,
      status: row.status,
      channelId: row.channelId,
      channelName: channel?.name ?? row.channelId,
      projectId: row.projectId,
      projectName: project?.name ?? null,
      workItemId: row.projectWorkItemId,
      workItemTitle: workItem?.title ?? null,
      objective: workItem?.brief || project?.objective || row.title,
      rootTaskId: taskRows.find(t => !t.state.startsWith('SUPERSEDED'))?.id ?? null,
      currentTask,
      tasks: scopeTasks,
      deliverables,
      recentMessages,
      decisions,
      openQuestions,
      nextStep: this.nextStep(currentTask, recentMessages.length),
      lastActiveAt,
      updatedAt: new Date().toISOString(),
    }
  }

  private nextStep(task: SessionTaskBrief | null, messageCount = 0): string {
    if (!task) return messageCount > 0 ? `会话进行中（${messageCount} 条消息）；等待成员回复或下一指令` : '等待首个任务或消息'
    if (task.state === 'SUBMITTED' || task.state === 'ASSIGNED') return '等待执行者接取'
    if (task.state === 'WORKING') return `执行中（${task.progress}%）`
    if (task.state === 'WAITING') return '等待子任务/上游输入'
    if (task.state === 'BLOCKED' || task.state === 'REWORK') return '需要处理阻塞/返工'
    if (task.state === 'COMPLETED') return '任务已完成，等待成果验收'
    return `任务状态 ${task.state}`
  }

  private toSummary(brief: SessionBrief): string {
    return short([
      `${brief.kind} session ${brief.sessionId}（${brief.status}）`,
      brief.projectName ? `项目：${brief.projectName}` : '',
      brief.workItemTitle ? `工作项：${brief.workItemTitle}` : '',
      brief.currentTask ? `当前任务：${brief.currentTask.title} [${brief.currentTask.state} ${brief.currentTask.progress}%]` : '',
      brief.nextStep ? `下一步：${brief.nextStep}` : '',
      brief.openQuestions.length ? `未决：${brief.openQuestions.join('；')}` : '',
    ].filter(Boolean).join('；'), 600)
  }
}

/** 供 prompt 使用的有界文本（≤ ~400 tok 目标）。 */
export function formatBriefText(brief: SessionBrief): string {
  const lines = [
    `## Session Context (authoritative)`,
    `session_id=${brief.sessionId} | kind=${brief.kind} | status=${brief.status}`,
    `title=${brief.title}`,
    brief.projectName ? `project=${brief.projectName}` : '',
    brief.workItemTitle ? `work_item=${brief.workItemTitle}` : '',
    brief.objective ? `objective=${short(brief.objective, 240)}` : '',
    brief.currentTask
      ? `current_task=${brief.currentTask.title} [${brief.currentTask.state} ${brief.currentTask.progress}%]`
      : 'current_task=(none)',
    brief.tasks.length
      ? `tasks=${brief.tasks.slice(0, 8).map(t => `${t.title}[${t.state}]`).join('; ')}`
      : '',
    brief.deliverables.length
      ? `deliverables=${brief.deliverables.slice(0, 5).map(d => `${d.name}(${d.bytes}B)`).join('; ')}`
      : '',
    brief.recentMessages.length
      ? `recent=${brief.recentMessages.slice(-4).map(m => `${m.role}:${short(m.text, 120)}`).join(' | ')}`
      : '',
    brief.decisions.length
      ? `decisions=${brief.decisions.slice(0, 3).map(d => short(d.text, 100)).join('; ')}`
      : '',
    brief.openQuestions.length ? `open_questions=${brief.openQuestions.join('; ')}` : '',
    `next_step=${brief.nextStep}`,
    `## Session Boundary`,
    `- This session is the only authoritative context.`,
    `- Do not reuse facts, task ids, artifact paths, or decisions from other sessions unless they appear above.`,
    `- If you need another session, use the session catalog/API; never guess.`,
  ]
  return lines.filter(Boolean).join('\n')
}
