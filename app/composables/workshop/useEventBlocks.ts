/**
 * 事件聚合器 — Codex/OpenHands 风格的"turn block"派生态。
 * 纯函数:输入过滤后的 AEP 信封序列(升序),输出连续聚合块。
 *
 * 聚合规则(仅连续事件合并,绝不跨行拼块):
 *  - 同 agent + 同 类别 → 合并为一个块(agent 徽标/时间只渲染一次)
 *  - agent.delta + agent.message 同 agent 连续 → 合并为"stream"气泡(打字机 + 落定消息不割裂)
 *  - task.status / task.progress 同 agent 且同 taskId → 合并(状态链紧凑呈现)
 *  - agent.status(生命周期)连续 → 合并,只显示最新状态 + 次数
 *  - 不同 agent / 不同类别 / 不同任务 → 开新块(保持时序边界清晰)
 */
import type { AepEnvelope } from '#shared/workshop-protocol'

export type BlockKind
  = | 'tool' // 🔧 工具调用
    | 'status' // 中间状态文本
    | 'life' // agent 生命周期(idle/busy/stopped)
    | 'route' // 点对点消息投递
    | 'stream' // LLM 输出(delta 打字机 + message 气泡)
    | 'task' // 任务状态迁移/进度
    | 'artifact' // 交付物
    | 'member' // 团队成员变更
    | 'memory' // 记忆沉淀
    | 'error' // 错误
    | 'other'

export interface EventBlock {
  id: string
  kind: BlockKind
  agentId: string | null
  /** 任务语义块(task/artifact 类别):同块内所有事件属于该任务 */
  taskId: string | null
  events: AepEnvelope[]
  firstAt: string
  lastAt: string
}

const TOOL_PREFIX = /^🔧\s*\S+/

/** 工具元数据:native = omp 原生作业工具;host = harness 协作工具(任务/通信/记忆/团队) */
export const TOOL_META: Record<string, { icon: string, kind: 'native' | 'host' }> = {
  read: { icon: 'i-tabler-file-search', kind: 'native' },
  write: { icon: 'i-tabler-pencil', kind: 'native' },
  edit: { icon: 'i-tabler-edit', kind: 'native' },
  bash: { icon: 'i-tabler-terminal-2', kind: 'native' },
  grep: { icon: 'i-tabler-search', kind: 'native' },
  glob: { icon: 'i-tabler-folders', kind: 'native' },
  dispatch_task: { icon: 'i-tabler-send', kind: 'host' },
  reassign_task: { icon: 'i-tabler-arrows-exchange', kind: 'host' },
  update_task: { icon: 'i-tabler-pencil-code', kind: 'host' },
  cancel_task: { icon: 'i-tabler-circle-x', kind: 'host' },
  complete_task: { icon: 'i-tabler-circle-check', kind: 'host' },
  report_progress: { icon: 'i-tabler-progress-check', kind: 'host' },
  send_message_to_agent: { icon: 'i-tabler-message', kind: 'host' },
  poll_messages: { icon: 'i-tabler-inbox', kind: 'host' },
  broadcast_message: { icon: 'i-tabler-rss', kind: 'host' },
  list_team_agents: { icon: 'i-tabler-users', kind: 'host' },
  list_channel_tasks: { icon: 'i-tabler-list', kind: 'host' },
  get_task_details: { icon: 'i-tabler-eye', kind: 'host' },
  get_my_task_queue: { icon: 'i-tabler-stack-2', kind: 'host' },
  get_queue_overview: { icon: 'i-tabler-chart-bar', kind: 'host' },
  search_memory: { icon: 'i-tabler-brain', kind: 'host' },
  save_memory: { icon: 'i-tabler-bookmark', kind: 'host' },
  create_team_agent: { icon: 'i-tabler-user-plus', kind: 'host' },
  update_team_agent: { icon: 'i-tabler-user-cog', kind: 'host' },
  remove_team_agent: { icon: 'i-tabler-user-minus', kind: 'host' },
}

/** 事件 → 聚合类别 */
export function classifyEvent(e: AepEnvelope): BlockKind {
  switch (e.type) {
    case 'agent.status.message':
      return TOOL_PREFIX.test(String((e.payload as { text?: string }).text ?? '')) ? 'tool' : 'status'
    case 'agent.status':
      return 'life'
    case 'a2a.message':
      return 'route'
    case 'agent.delta':
    case 'agent.message':
      return 'stream'
    case 'task.status':
    case 'task.progress':
      return 'task'
    case 'a2a.artifact':
      return 'artifact'
    case 'agent.member':
      return 'member'
    case 'memory.saved':
      return 'memory'
    case 'error':
      return 'error'
    default:
      return 'other'
  }
}

/** 块合并键:同 agent + 同类别(任务类再加 taskId)连续即同块 */
function blockKey(agentId: string | null, kind: BlockKind, taskId: string | null): string {
  if (kind === 'task' || kind === 'artifact') {
    return `${agentId ?? 'sys'}::${kind}::${taskId ?? 'none'}`
  }
  return `${agentId ?? 'sys'}::${kind}`
}

/** 序列 → 聚合块(输入必须按 seq 升序) */
export function aggregateEvents(events: AepEnvelope[]): EventBlock[] {
  const blocks: EventBlock[] = []
  let current: EventBlock | null = null
  let currentKey = ''

  for (const e of events) {
    const kind = classifyEvent(e)
    const agentId = e.agentId ?? null
    const taskId = e.type === 'task.status' || e.type === 'task.progress' || e.type === 'a2a.artifact'
      ? String((e.payload as { taskId?: string }).taskId ?? null)
      : null

    const key = blockKey(agentId, kind, taskId)

    if (current && key === currentKey) {
      current.events.push(e)
      current.lastAt = e.at
      continue
    }

    current = {
      id: `b${e.seq}-${kind}`,
      kind,
      agentId,
      taskId,
      events: [e],
      firstAt: e.at,
      lastAt: e.at,
    }
    currentKey = key
    blocks.push(current)
  }

  return blocks
}

/** agent 稳定配色(id hash → hue;无 id 灰) */
export function agentHueColor(agentId: string | null | undefined): string {
  if (!agentId) return '#8c8c8c'
  let h = 0
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 65%, 55%)`
}
