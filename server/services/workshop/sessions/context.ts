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

export interface SessionTurnItem {
  id: string
  role: 'user' | 'agent'
  name: string
  text: string
  at: string
}

export interface SessionCompressedState {
  /** 兼容旧 brief 的观测字段；cursor 用 persisted message identity + created_at，并校验当前行未被删除/复用。 */
  uptoSeq: number
  /** 已折叠消息 identity；每次续读先校验行仍存在，避免 SQLite 回收 rowid 后跳过新消息。 */
  uptoCreatedAt: string
  uptoMessageId: string
  lines: string[]
  generation: number
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
  recentTurns: SessionTurnItem[]
  /** 压缩层快照；cursor 使用稳定 created_at + message id，uptoSeq 仅保留兼容观测。 */
  compressed: { uptoSeq: number, uptoCreatedAt: string, uptoMessageId: string, generation: number, lines: string[] }
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

/** ── 注入 v2：分层装配常量 ─────────────────────────────────────────── */

/** 近期对话层：逐条原文的窗口大小 */
const RECENT_TURN_LIMIT = 8
/** 近期对话层字符预算（超限从最旧开始丢整条） */
const RECENT_CHAR_BUDGET = 2400
/** 近期单条最大字符 */
const RECENT_ITEM_MAX = 300
/** 压缩层字符预算 */
const COMPRESSED_CHAR_BUDGET = 1200
/** pinned 行上限（决策/结论/未决/风险/交付） */
const PINNED_MAX = 14
/** 话题行上限 */
const TOPIC_MAX = 10
/** pinned 行判定：消息正文以这些前缀开头时原文进压缩层 */
const PINNED_LINE_RE = /^\s*(决策|结论|决定|问题|未决|风险|交付|交付物|验收)\s*[:：]/

function charsOf(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length, 0)
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
    // 压缩状态跨代携带：从上一份 brief_json 读取，窗口外新消息增量折叠。
    const prev = parseJson<{ compressed?: Partial<SessionCompressedState> } | null>(row.briefJson, null)
    const stored = prev?.compressed
    const compressed = this.foldOlderMessages(row, {
      uptoSeq: Number.isSafeInteger(Number(stored?.uptoSeq)) && Number(stored?.uptoSeq) >= 0 ? Number(stored?.uptoSeq) : 0,
      // Old briefs only persisted uptoSeq; an empty stable cursor safely replays
      // their rows and the existing line de-duplication keeps this idempotent.
      uptoCreatedAt: typeof stored?.uptoCreatedAt === 'string' ? stored.uptoCreatedAt : '',
      uptoMessageId: typeof stored?.uptoMessageId === 'string' ? stored.uptoMessageId : '',
      lines: Array.isArray(stored?.lines) ? stored.lines.filter((line): line is string => typeof line === 'string') : [],
      generation: Number.isSafeInteger(Number(stored?.generation)) && Number(stored?.generation) >= 0 ? Number(stored?.generation) : 0,
    })
    const brief = this.assemble(row, compressed)
    if (opts.refresh) {
      this.sessions.updateBrief(sessionId, {
        summary: this.toSummary(brief),
        briefJson: JSON.stringify(brief),
        lastActiveAt: brief.lastActiveAt,
      })
    }
    return brief
  }

  /**
   * 提取式压缩：把「窗口外且未折叠」的旧消息并入压缩层。
   * pinned 行（决策/结论/未决/风险/交付 前缀）原文保留；其余压成话题行。
   * 全程确定性、幂等（uptoId 推进 + 行去重），不调 LLM。
   */
  private foldOlderMessages(row: ChannelSessionRow, state: SessionCompressedState): SessionCompressedState {
    const windowStart = Math.max(0, this.countSessionMessages(row) - RECENT_TURN_LIMIT)
    const boundary = this.sessionMessageBoundaryAtOffset(row, windowStart)
    if (!boundary) return state
    const cursor = this.validCompactionCursor(row, state)
    const older = this.listSessionMessagesBefore(row, cursor, boundary, 200)
    if (older.length === 0) return state
    const pinned: string[] = []
    const topics: string[] = []
    for (const m of older) {
      if (!m.text) continue
      if (PINNED_LINE_RE.test(m.text)) pinned.push(short(`${m.name}: ${m.text}`, 200))
      else topics.push(`· ${m.name}: ${short(m.text, 36)}`)
    }
    const merged = [...new Set([...state.lines, ...pinned, ...topics])]
    const lines = this.trimCompressedLines(merged)
    const last = older[older.length - 1]
    return {
      uptoSeq: last ? last.seq : cursor.uptoSeq,
      uptoCreatedAt: last?.at ?? cursor.uptoCreatedAt,
      uptoMessageId: last?.id ?? cursor.uptoMessageId,
      lines,
      generation: state.generation + 1,
    }
  }

  /** cursor 行存在且 identity 匹配时沿用 rowid；否则从 session 头部重放。 */
  private validCompactionCursor(session: ChannelSessionRow, state: SessionCompressedState): SessionCompressedState {
    if (!state.uptoCreatedAt || !state.uptoMessageId || state.uptoSeq <= 0) {
      return { ...state, uptoSeq: 0, uptoCreatedAt: '', uptoMessageId: '' }
    }
    const found = this.db.prepare(
      'SELECT created_at AS at, id FROM messages WHERE session_id = ? AND rowid = ?',
    ).get(session.id, state.uptoSeq) as { at: string, id: string } | undefined
    if (found?.at === state.uptoCreatedAt && found.id === state.uptoMessageId) return state
    return { ...state, uptoSeq: 0, uptoCreatedAt: '', uptoMessageId: '' }
  }

  /** 按 created_at + rowid 的 session 最新窗口；rowid 只作同毫秒入队顺序。 */
  private listSessionMessages(row: ChannelSessionRow, limit: number): Array<{ id: string, seq: number, role: 'user' | 'agent', name: string, text: string, at: string }> {
    const rows = this.db.prepare(
      `SELECT id, rowid AS seq, role, from_agent_id AS fromAgentId, to_agent_id AS toAgentId,
              parts_json AS partsJson, created_at AS at
       FROM messages
       WHERE session_id = ?
       ORDER BY rowid DESC LIMIT ?`,
    ).all(row.id, limit) as Array<{ id: string, seq: number, role: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, at: string }>
    return rows.reverse().map(m => ({
      id: m.id,
      seq: Number(m.seq),
      role: m.role === 'ROLE_USER' ? 'user' as const : 'agent' as const,
      name: m.role === 'ROLE_USER' ? '人类' : (m.fromAgentId ?? '系统'),
      text: textOfParts(m.partsJson),
      at: m.at,
    })).filter(m => m.text)
  }

  /** 按稳定 rowid 批次读取；cursor identity 校验防止 retention 后复用造成跳过。 */
  private listSessionMessagesBefore(
    row: ChannelSessionRow,
    state: SessionCompressedState,
    boundary: { at: string, id: string, seq: number },
    limit: number,
  ): Array<{ id: string, seq: number, role: 'user' | 'agent', name: string, text: string, at: string }> {
    const rows = this.db.prepare(
      `SELECT id, rowid AS seq, role, from_agent_id AS fromAgentId, to_agent_id AS toAgentId,
              parts_json AS partsJson, created_at AS at
       FROM messages
       WHERE session_id = ? AND rowid > ? AND rowid <= ?
       ORDER BY rowid ASC LIMIT ?`,
    ).all(row.id, state.uptoSeq, boundary.seq, limit) as Array<{ id: string, seq: number, role: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, at: string }>
    return rows.map(m => ({
      id: m.id,
      seq: Number(m.seq),
      role: m.role === 'ROLE_USER' ? 'user' as const : 'agent' as const,
      name: m.role === 'ROLE_USER' ? '人类' : (m.fromAgentId ?? '系统'),
      text: textOfParts(m.partsJson),
      at: m.at,
    }))
  }

  private countSessionMessages(row: ChannelSessionRow): number {
    const result = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(row.id) as { count: number }
    return Number(result.count ?? 0)
  }

  /** 按同一入队 rowid 顺序定位 recent 边界；created_at/id 仅用于 cursor 复用校验。 */
  private sessionMessageBoundaryAtOffset(row: ChannelSessionRow, offset: number): { at: string, id: string, seq: number } | undefined {
    if (offset <= 0) return undefined
    return this.db.prepare(
      `SELECT created_at AS at, id, rowid AS seq FROM messages
       WHERE session_id = ? ORDER BY rowid ASC LIMIT 1 OFFSET ?`,
    ).get(row.id, offset - 1) as { at: string, id: string, seq: number } | undefined
  }

  /** 压缩层确定性保留：优先保留最新 pinned，再用剩余预算保留最新 topics。 */
  private trimCompressedLines(lines: string[]): string[] {
    const pinned = lines.filter(l => !l.startsWith('· ')).slice(-PINNED_MAX)
    const topics = lines.filter(l => l.startsWith('· ')).slice(-TOPIC_MAX)
    const keptPinned: string[] = []
    for (const line of pinned.reverse()) {
      const bounded = short(line, 200)
      if (charsOf(keptPinned) + bounded.length > COMPRESSED_CHAR_BUDGET) continue
      keptPinned.unshift(bounded)
    }
    const keptTopics: string[] = []
    for (const line of topics.reverse()) {
      if (charsOf(keptPinned) + charsOf(keptTopics) + line.length > COMPRESSED_CHAR_BUDGET) continue
      keptTopics.unshift(line)
    }
    return [...keptPinned, ...keptTopics]
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
    const tasks = this.db.prepare(
      `SELECT id, title, state, progress, created_at AS at, rowid AS sourceSeq FROM tasks
       WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(sessionId, limit) as Array<{ id: string, title: string, state: string, progress: number, at: string, sourceSeq: number }>
    const messages = this.db.prepare(
      `SELECT id, role, from_agent_id AS fromAgentId, to_agent_id AS toAgentId,
              parts_json AS partsJson, created_at AS at, rowid AS sourceSeq
       FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(sessionId, limit) as Array<{ id: string, role: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, at: string, sourceSeq: number }>
    const history: Array<SessionHistoryItem & { source: 0 | 1, sourceSeq: number }> = [
      ...tasks.map(t => ({
        type: 'task' as const,
        id: t.id,
        at: t.at,
        taskId: t.id,
        text: t.title,
        state: t.state,
        progress: Number(t.progress ?? 0),
        source: 0 as const,
        sourceSeq: Number(t.sourceSeq),
      })),
      ...messages.map(m => ({
        type: 'message' as const,
        id: m.id,
        at: m.at,
        role: m.role,
        name: m.fromAgentId ?? m.toAgentId ?? 'system',
        text: textOfParts(m.partsJson),
        source: 1 as const,
        sourceSeq: Number(m.sourceSeq),
      })),
    ]
    return history
      .filter(h => Boolean(h.text))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.source - b.source || a.sourceSeq - b.sourceSeq)
      .slice(-limit)
      .map(({ source: _source, sourceSeq: _sourceSeq, ...item }) => item)
  }

  /** 当前 channel 的 active session（任务实例/项目办公室优先）。 */
  activeForChannel(channelId: string): ChannelSessionRow | undefined {
    return this.sessions.listByChannel(channelId).find(s => s.status === 'active')
  }

  private assemble(row: ChannelSessionRow, compressed: SessionCompressedState): SessionBrief {
    const channel = this.db.prepare('SELECT name FROM channels WHERE id = ?').get(row.channelId) as { name: string } | undefined
    const project = row.projectId
      ? this.db.prepare('SELECT name, objective FROM projects WHERE id = ?').get(row.projectId) as { name: string, objective: string } | undefined
      : undefined
    const workItem = row.projectWorkItemId
      ? this.db.prepare('SELECT title, brief FROM project_work_items WHERE id = ?').get(row.projectWorkItemId) as { title: string, brief: string } | undefined
      : undefined
    const taskRows = this.db.prepare(
      `SELECT id, title, state, progress, assignee_id AS assigneeId, artifacts_json AS artifactsJson, updated_at AS updatedAt
       FROM tasks WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    ).all(row.id) as Array<{
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
    const messages = this.listSessionMessages(row, 12)
    const recentTurns: SessionTurnItem[] = messages
      .slice(-RECENT_TURN_LIMIT)
      .map(m => ({ id: m.id, role: m.role, name: m.name, text: short(m.text, RECENT_ITEM_MAX), at: m.at }))
    const recentMessages = messages.map(m => ({
      role: m.role,
      name: m.name,
      text: short(m.text, 240),
      at: m.at,
    }))
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
      recentTurns,
      compressed: {
        uptoSeq: compressed.uptoSeq,
        uptoCreatedAt: compressed.uptoCreatedAt,
        uptoMessageId: compressed.uptoMessageId,
        generation: compressed.generation,
        lines: compressed.lines,
      },
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

/**
 * 供 prompt 使用的分层装配文本（注入 v2）。
 *
 * 三层（profile=full）：身份与要点 → 关键事实(pinned) → 早期压缩 → 近期原文 → 边界规则。
 * profile=brief（有原生会话的引擎，如 claude resume 试点）：只保留身份与要点 + pinned，
 * 近期/早期层整体省略（历史由 harness 原生会话承载）。
 * 每层都有硬预算：pinned ≤14 行、压缩 ≤1200 chars、近期 ≤8 条 ×300 chars 且总 ≤2400 chars。
 */
export function formatBriefText(brief: SessionBrief, profile: 'full' | 'brief' = 'full'): string {
  const lines = [
    `## Session Context (authoritative)`,
    `session_id=${brief.sessionId} | kind=${brief.kind} | status=${brief.status} | profile=${profile}`,
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
    brief.decisions.length
      ? `decisions=${brief.decisions.slice(0, 3).map(d => short(d.text, 100)).join('; ')}`
      : '',
    brief.openQuestions.length ? `open_questions=${brief.openQuestions.join('; ')}` : '',
    `next_step=${brief.nextStep}`,
  ]
  // ── 关键事实（pinned）：来自压缩层里的原文行（决策/结论/未决/风险/交付 前缀的行）
  const pinnedLines = brief.compressed.lines.filter(l => !l.startsWith('· '))
  if (pinnedLines.length) {
    lines.push(`### 关键事实 (pinned)`)
    lines.push(...pinnedLines.map(l => `- ${l}`))
  }
  if (profile === 'full') {
    // ── 早期上下文（compressed）：窗口外旧轮次的提取式压缩
    const topicLines = brief.compressed.lines.filter(l => l.startsWith('· '))
    if (topicLines.length || brief.compressed.generation > 0) {
      lines.push(`### 早期上下文 (compressed, generation=${brief.compressed.generation})`)
      if (topicLines.length) lines.push(...topicLines)
      else lines.push('（更早的对话已并入关键事实；无额外话题）')
    }
    // ── 近期对话（recent）：逐条原文，窗口 8 条 ×300 chars，总 ≤2400 chars；
    // 超预算时从最旧一侧丢弃（从最新往回保留连续窗口）。
    const turns: string[] = brief.recentTurns.map(m => `[${m.at.slice(11, 16)}] ${m.name}: ${m.text}`)
    const budgeted: string[] = []
    let used = 0
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i] ?? ''
      if (used + t.length > RECENT_CHAR_BUDGET) break
      budgeted.unshift(t)
      used += t.length
    }
    lines.push(`### 近期对话 (recent, ${budgeted.length} turns)`)
    if (budgeted.length) lines.push(...budgeted)
    else lines.push('（暂无对话）')
  }
  lines.push(`## Session Boundary`)
  lines.push(`- This session is the only authoritative context.`)
  lines.push(`- Do not reuse facts, task ids, artifact paths, or decisions from other sessions unless they appear above.`)
  lines.push(`- If you need another session, use the session catalog/API; never guess.`)
  return lines.filter(Boolean).join('\n')
}
