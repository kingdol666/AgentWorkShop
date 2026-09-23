/**
 * 类别 / 工具的展示元数据(壳层与块渲染端图标、标签的唯一来源)。
 */
import type { BlockKind } from './types'

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

/** 类别展示元数据(壳层统一渲染头部) */
export const KIND_META: Record<BlockKind, { label: string, icon: string }> = {
  tool: { label: 'tool', icon: 'i-tabler-tool' },
  status: { label: 'status', icon: 'i-tabler-dots' },
  life: { label: 'state', icon: 'i-tabler-activity' },
  route: { label: 'message', icon: 'i-tabler-route' },
  stream: { label: 'llm', icon: 'i-tabler-message-dots' },
  task: { label: 'task', icon: 'i-tabler-checklist' },
  artifact: { label: 'artifact', icon: 'i-tabler-package' },
  member: { label: 'team', icon: 'i-tabler-users' },
  memory: { label: 'memory', icon: 'i-tabler-bookmark' },
  error: { label: 'error', icon: 'i-tabler-alert-triangle' },
  other: { label: 'event', icon: 'i-tabler-dots' },
}
