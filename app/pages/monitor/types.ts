/**
 * 监控页的数据契约 —— 与 server/runtime/manager.ts 的 RuntimeMonitorSnapshot 对齐。
 *
 * 页面私有类型刻意放 app/pages/monitor/(该目录下只有 .ts 安全:任何 .vue,
 * 包括子目录里的,都会被 Nuxt 当成路由)。
 */

/** 与 server/runtime/manager.ts RuntimeMonitorSnapshot 对齐 */
export interface ProcessInfo { pid: number, alive: boolean, command: string }
export interface ChannelView {
  channelId: string
  wiredAgentCount: number
  memberCount: number
  hasScheduler: boolean
  leadAgentId: string | null
  ownerUserId?: string | null
  ownerName?: string | null
}
export interface AgentView {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  harness: string
  state: 'idle' | 'busy' | 'stopped'
  currentTaskId: string | null
  queuedCount: number
  completedCount: number
  process: ProcessInfo | null
  ownerUserId?: string | null
  ownerName?: string | null
}
export interface ProcessView {
  pid: number
  harness: string
  command: string
  args: string[]
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  startedAt: number
  alive: boolean
  exitCode: number | null
  bound: boolean
  /** 终端镜像可接入(harness-terminal tap 已挂载) */
  terminal: boolean
}
export interface MonitorSnapshot {
  generatedAt: string
  serverPid: number
  uptimeMs: number
  /** 视图范围:user = 本人资源 | admin = 全量(附归属标注) */
  scope?: 'user' | 'admin'
  ownerNames?: Record<string, string>
  channels: ChannelView[]
  agents: AgentView[]
  processes: ProcessView[]
  counts: { channels: number, agents: number, processes: number, aliveProcesses: number, orphanProcesses: number }
}
export interface ApiEnvelope<T> { code: number | string, message: string, data: T | null }
