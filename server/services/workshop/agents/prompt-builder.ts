/**
 * PromptBuilder —— 回合 prompt 组装(harness 无关)。
 *
 * 从 omp-agent 抽出:场景 × 身份 × 工业简报 × 团队名册 × 记忆 × 系统手册 ×
 * 工作流/调度指令的全部组合逻辑。所有 harness impl(omp/codex/dsh/opencode)
 * 用同一函数组装回合 prompt,保证"omp 运行时注入的内容"在其余引擎等价注入。
 * 模板与提示词仍外置 .AgentWorkShop/prompts/(loader 渲染)。
 */
import type {
  AgentInfo,
  AgentRunContext,
  SupervisionSnapshot,
} from './agent-interface'
import { renderPrompt } from '../prompts/loader'
import { buildIndustrialContext, industrialLoopGuide } from './industrial-context'

/** 工具参数预览(Codex 式紧凑工具行):`name(path)` / `name(a=1, b=2)` */
export function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const a = args as Record<string, unknown>
  const single = ['path', 'file', 'filename', 'command', 'cmd', 'query', 'pattern', 'url', 'taskId', 'task_id', 'id', 'name', 'toolName']
  const pick = single.find(k => typeof a[k] === 'string' && (a[k] as string).length > 0)
  let preview: string
  if (pick) {
    preview = (a[pick] as string)
  }
  else {
    const scalars = Object.entries(a)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .slice(0, 2)
      .map(([k, v]) => `${k}=${String(v)}`)
    if (scalars.length === 0) return ''
    preview = scalars.join(', ')
  }
  const flat = preview.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return `(${flat.length > 64 ? `${flat.slice(0, 64)}…` : flat})`
}

/** 安全 JSON 解析(容错:提取第一个 JSON 数组;supervise 文本决策兜底用) */
export function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    return null
  }
  catch {
    // 继续
  }
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    }
    catch {
      // 继续
    }
  }
  return null
}

/**
 * 前置上下文段(channel 场景 + 实例身份):场景优先级最高——用户对整个作业
 * 场景的规范要求,全体成员共享;未设定时注入通用默认场景(prompts/scenario-default.md)。
 * 附工业工况简报与调控作业环(有绑定节点才注入)。
 */
export function contextPrefix(opts: {
  scenarioPrompt?: string
  systemPromptPrefix?: string
  agentId: string
  roster?: string
}): string {
  const scenario = typeof opts.scenarioPrompt === 'string' ? opts.scenarioPrompt.trim() : ''
  const identity = opts.systemPromptPrefix ?? ''
  const parts: string[] = []
  parts.push(
    scenario
      ? `## Scenario Brief (channel-wide, highest priority — user-defined operating rules)\n${scenario}`
      : renderPrompt('scenario-default'),
    ``,
  )
  if (identity) {
    parts.push(
      `## Your Profile (agent-specific)\n${identity}`,
      ``,
    )
  }
  // 工业工况简报(实时):本 Agent 绑定节点所在的产线运行状态/活动配方窗口/关联设备
  // 孪生遥测 —— 让 Agent 每次回合开头就知道自己在哪条产线、生产什么、窗口多少、
  // 设备当前状态,从而把节点读写放进工艺上下文里决策(而非盲操作)。
  const industrial = buildIndustrialContext(opts.agentId)
  if (industrial) {
    parts.push(industrial, ``)
  }
  // 工业调控作业环(方法论层):有绑定节点才注入 —— 保证 Agent 在拿到任何
  // 工具之前就理解「观察→理解→窗口内小步幅→执行→复测」的调控纪律。
  const loop = industrialLoopGuide(opts.agentId)
  if (loop) {
    parts.push(loop, ``)
  }
  if (opts.roster) {
    parts.push(opts.roster, ``)
  }
  return parts.join('\n')
}

/** 系统设计手册(prompts/system-manual.md):让 agent 真正理解其运行环境。 */
export function systemManual(): string {
  return renderPrompt('system-manual')
}

export interface RosterCache {
  /** 名册文本(30s TTL;拉取失败置空下次重试,寻址层另有名字容错兜底) */
  roster(): Promise<string>
  invalidate(): void
}

/**
 * 团队名册缓存(prompts/team-roster.md):每位成员一行 — id(寻址键)/名字/角色/
 * harness/专长;自己的条目带 ← 你 标记。所有回合(worker/supervise/peer)统一注入。
 */
export function createRosterCache(opts: {
  selfAgentId: string
  listAgents: () => Promise<AgentInfo[]>
}): RosterCache {
  let cache: string | null = null
  let at = 0
  return {
    async roster(): Promise<string> {
      if (cache !== null && Date.now() - at < 30_000) return cache
      try {
        const agents = await opts.listAgents()
        const condense = (s: unknown): string =>
          String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 110)
        const lines = agents
          .filter(a => a.enabled !== 0)
          .map((a) => {
            const specialty = condense(a.config?.systemPromptPrefix)
            const self = a.id === opts.selfAgentId ? ' ← 你' : ''
            return `- id: ${a.id} | ${a.name}${self} | role=${a.role} | harness=${a.harness}${specialty ? ` | 擅长: ${specialty}` : ''}`
          })
          .join('\n')
        cache = renderPrompt('team-roster', { rosterLines: lines })
        at = Date.now()
      }
      catch {
        cache = null
        at = 0
      }
      return cache ?? ''
    },
    invalidate(): void {
      cache = null
      at = 0
    },
  }
}

/** worker 任务回合 prompt(与原 omp 组装逐段一致) */
export function workerPrompt(opts: {
  agentName: string
  channelId: string
  taskId: string
  taskText: string
  memory?: string
  ctxPrefix: string
  manual: string
}): string {
  const parts: string[] = []
  if (opts.ctxPrefix) parts.push(opts.ctxPrefix)
  if (opts.memory) parts.push(opts.memory)
  parts.push(opts.manual)
  parts.push(renderPrompt('worker-workflow', {
    agentName: opts.agentName,
    channelId: opts.channelId,
    taskId: opts.taskId,
    taskText: opts.taskText,
  }))
  return parts.join('\n')
}

/** 点对点消息回合 prompt(触发器语义/回执关联/跨 Channel 三态,模板外置) */
export function peerPrompt(opts: {
  agentName: string
  role: 'lead' | 'worker'
  channelId: string
  ctxPrefix: string
  manual: string
  memory?: string
  fromId: string
  messageId: string
  requireReply: boolean
  isReply: boolean
  crossChannel: boolean
  fromChannel: string
  msgText: string
}): string {
  const roleLine = opts.role === 'lead'
    ? `You are "${opts.agentName}", the LEAD coordinator of a multi-agent team (Channel: ${opts.channelId}). A team member sent you a direct message.`
    : `You are "${opts.agentName}", a worker agent in a multi-agent team (Channel: ${opts.channelId}).`

  const respondBlock = opts.crossChannel
    ? renderPrompt('peer-reply-cross-channel', { fromId: opts.fromId, messageId: opts.messageId, fromChannel: opts.fromChannel })
    : renderPrompt(opts.requireReply ? 'peer-reply-required' : 'peer-reply-optional', {
        fromId: opts.fromId,
        messageId: opts.messageId,
      })
  const peerBody = renderPrompt('peer-message', {
    fromId: opts.fromId,
    messageId: opts.messageId,
    requireReply: opts.requireReply,
    isReplyTo: opts.isReply ? `in_reply_to: ${opts.messageId}` : '',
    msgText: opts.msgText,
    respondBlock,
  })
  const lines: string[] = [
    roleLine,
    ``, opts.ctxPrefix,
    ``, opts.manual,
    ``,
    ...(opts.memory ? [``, opts.memory] : []),
    ``,
    peerBody,
  ]
  if (opts.role === 'lead') {
    lines.push(``, renderPrompt('peer-lead-roster'))
  }
  return lines.join('\n')
}

/**
 * 成员能力画像(koda 运营信号借鉴):按任务历史计算
 * total/completed/failed/successRate/avgDurationMs(仅统计已终态任务)。
 */
function capabilityProfiles(snapshot: SupervisionSnapshot): Map<string, { total: number, completed: number, failed: number, successRate: number, avgDurationMs: number }> {
  const byAgent = new Map<string, { total: number, completed: number, failed: number, durationSum: number }>()
  for (const t of snapshot.tasks) {
    if (!['COMPLETED', 'FAILED'].includes(t.state)) continue
    const agg = byAgent.get(t.assigneeId) ?? { total: 0, completed: 0, failed: 0, durationSum: 0 }
    agg.total += 1
    if (t.state === 'COMPLETED') {
      agg.completed += 1
      agg.durationSum += Math.max(0, new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime())
    }
    else {
      agg.failed += 1
    }
    byAgent.set(t.assigneeId, agg)
  }
  const out = new Map<string, { total: number, completed: number, failed: number, successRate: number, avgDurationMs: number }>()
  for (const [agentId, agg] of byAgent) {
    out.set(agentId, {
      total: agg.total,
      completed: agg.completed,
      failed: agg.failed,
      successRate: agg.total > 0 ? agg.completed / agg.total : 0,
      avgDurationMs: agg.completed > 0 ? agg.durationSum / agg.completed : 0,
    })
  }
  return out
}

/** 从 description 前缀检测执行模式 */
function detectMode(desc: string): { mode: string, criteria?: string, stages?: string[], interval?: number } | null {
  const match = desc.match(/^\[mode:(goal|loop|pipeline)\]/)
  if (!match) return null
  const mode = match[1]!
  const result: { mode: string, criteria?: string, stages?: string[], interval?: number } = { mode }
  if (mode === 'goal') {
    const crit = desc.match(/\[criteria:([^\]]+)\]/)
    if (crit) result.criteria = crit[1]
  }
  if (mode === 'loop') {
    const intv = desc.match(/\[interval:(\d+)\]/)
    if (intv) result.interval = parseInt(intv[1]!, 10)
  }
  if (mode === 'pipeline') {
    const stg = desc.match(/\[stages:([^\]]+)\]/)
    if (stg) result.stages = stg[1]!.split('->')
  }
  return result
}

/** 构建模式特定指令(外置 mode-goal/loop/pipeline.md) */
function buildModeInstructions(modeInfo: { mode: string, criteria?: string, stages?: string[], interval?: number }): string[] {
  if (modeInfo.mode === 'goal') {
    return [renderPrompt('mode-goal', { criteria: modeInfo.criteria ?? '任务描述中的需求已全部完成' })]
  }
  if (modeInfo.mode === 'loop') {
    return [renderPrompt('mode-loop', { interval: (modeInfo.interval ?? 60000) / 1000 })]
  }
  if (modeInfo.mode === 'pipeline') {
    const stageList = modeInfo.stages?.length
      ? modeInfo.stages.map((s, i) => `  Stage ${i + 1}: ${s}`).join('\n')
      : '  Decompose the task into sequential stages yourself.'
    return [renderPrompt('mode-pipeline', { stageList })]
  }
  return []
}

/** lead 调度回合 prompt(快照格式化 + 能力画像 + 邮件 + 模式指令,与原 omp 一致) */
export function supervisePrompt(opts: {
  snapshot: SupervisionSnapshot
  agentName: string
  channelId: string
  ctxPrefix: string
  manual: string
  memory?: string
}): string {
  const snapshot = opts.snapshot
  const parts: string[] = []
  if (opts.ctxPrefix) parts.push(opts.ctxPrefix)
  if (opts.memory) parts.push(opts.memory)
  parts.push(opts.manual)

  const capability = capabilityProfiles(snapshot)
  const members = snapshot.members.map((m) => {
    const cap = capability.get(m.agentId)
    const capLine = cap && cap.total > 0
      ? `, 成功率=${Math.round(cap.successRate * 100)}%, 均耗时=${Math.round(cap.avgDurationMs / 1000)}s, 失败=${cap.failed}`
      : ', 暂无历史'
    const prog = m.currentTaskProgress != null
      ? `, progress=${m.currentTaskProgress}%${m.stalled ? ' [STALLED 停滞,请介入:notify/reassign/cancel]' : ''}`
      : ''
    const execTitle = m.currentTaskTitle ? `「${m.currentTaskTitle}」` : ''
    return `  - ${m.agentId} (${m.name}, role=${m.role}, state=${m.state}, executing=${m.currentTaskId ?? '-'}${execTitle}, queued=${m.queued ?? 0}, completed=${m.completedCount ?? 0}${prog}${capLine})`
  }).join('\n')

  const tasks = snapshot.tasks.map((t) => {
    const deliverable = t.state === 'COMPLETED' && t.artifacts.length > 0
      ? ` — 交付:${t.artifacts.map(a => a.parts.map(p => 'text' in p ? p.text : '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).join(' / ').slice(0, 400) || '(空)'}`
      : ''
    const artifacts = t.artifacts.length > 0 ? `, artifacts=${t.artifacts.length}` : ''
    return `  - ${t.id} [${t.state}] "${t.title}" (assignee=${t.assigneeId}, progress=${t.progress}%${artifacts})${deliverable}`
  }).join('\n')

  const pending = Object.entries(snapshot.pendingChildren)
    .map(([parentId, count]) => `  ${parentId}: ${count} pending`)
    .join('\n')

  const mail = (snapshot.mail ?? []).map((m) => {
    const from = m.fromAgentId ?? '(system)'
    const to = m.toAgentId ?? '(broadcast)'
    const body = m.parts.map(p => 'text' in p ? p.text : JSON.stringify('data' in p ? p.data : p)).join(' ').trim().slice(0, 140)
    const label = m.metadata?.['x-aw-task-kind'] === 'assign'
      ? 'task-assign'
      : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'peer'
    return `  - [${m.createdAt.slice(11, 19)}] ${from} → ${to} (${label}): ${body || '(empty)'}`
  }).join('\n')

  const leadTask = snapshot.tasks.find(t =>
    t.assigneeId === snapshot.members.find(m => m.role === 'lead')?.agentId
    && (t.state === 'SUBMITTED' || t.state === 'WORKING' || t.state === 'WAITING'),
  )
  const modeInfo = leadTask ? detectMode(leadTask.description ?? '') : null

  parts.push(
    `You are "${opts.agentName}", the lead coordinator of a multi-agent team (Channel: ${opts.channelId}).`,
    `Tick #${snapshot.tick}`,
    ``,
    `## Team Members (state + task queues)`,
    members || '  (none)',
    ``,
    `## All Tasks (FIFO order)`,
    tasks || '  (none)',
    ``,
    `## Pending Children Count`,
    pending || '  (none)',
    ``,
    `## Recent Team Mail (newest first)`,
    mail || '  (none)',
  )

  if (modeInfo) {
    parts.push('', ...buildModeInstructions(modeInfo))
  }
  else {
    parts.push('', renderPrompt('lead-supervise'))
  }

  return parts.join('\n')
}

/** steer 触发横幅解析(实时注入回执上下文;AgentRuntime.injectSteer 生成,格式固定) */
export function parseSteerBanner(text: string): { fromId: string, messageId: string } | null {
  const banner = text.match(/\[实时消息 from ([^\]]+)]:[\s\S]*?要求回复\(reply_to=([0-9a-f-]{36})\)/)
  return banner ? { fromId: banner[1]!, messageId: banner[2]! } : null
}

export type { AgentRunContext }
