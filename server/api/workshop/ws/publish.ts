/**
 * 事件发布(seq/环形缓冲/慢消费者断开)与快照构建
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepEnvelope, RootQueueView } from '../../../../shared/workshop-protocol'
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { WorkspaceTask } from '../../../services/workshop/types/task'
import type { ChannelStream } from './shared'
import { AEP_VERSION, DB_BUFFER_CAP, RING_BYTES_CAP, RING_CAP, hub } from './shared'
import { DB_FLUSH_MS, internalsOf, sendFrame } from './hub'
import { flushDbBuffer } from './db-buffer'
import { parseJson } from '../../../services/workshop/db/database'
import { rowToMessage } from '../../../services/workshop/runtime/mailbox'

export function publish(
  manager: AgentChannelManager,
  stream: ChannelStream,
  type: string,
  payload: unknown,
  ids: { agentId?: string, taskId?: string } = {},
): AepEnvelope {
  stream.seq += 1
  const e: AepEnvelope = {
    v: AEP_VERSION,
    type,
    seq: stream.seq,
    at: new Date().toISOString(),
    channelId: stream.channelId,
    ...ids,
    payload: payload as AepEnvelope['payload'],
  }
  // 环形缓冲:条数 + 字节双封顶(帧串行化一次,字节数直接可得)
  const frame = JSON.stringify(e)
  stream.ring.push({ e, bytes: frame.length })
  stream.ringBytes += frame.length
  while ((stream.ringBytes > RING_BYTES_CAP || stream.ring.length > RING_CAP) && stream.ring.length > 1) {
    const evicted = stream.ring.shift()!
    stream.ringBytes -= evicted.bytes
  }
  // 持久化(server 驱动):全部帧型进有序聚合缓冲,400ms 单事务批量刷盘。
  // 缓冲滞留超限即刷(库故障时防无限涨);失败仅记日志,不影响实时推送。
  stream.dbBuffer.push(e)
  if (stream.dbBuffer.length >= DB_BUFFER_CAP) {
    flushDbBuffer(manager, stream)
  }
  else if (!stream.dbFlushTimer) {
    stream.dbFlushTimer = setTimeout(() => {
      stream.dbFlushTimer = null
      if (hub.boundManager) flushDbBuffer(hub.boundManager, stream)
    }, DB_FLUSH_MS)
    stream.dbFlushTimer.unref?.()
  }
  for (const peer of stream.peers) sendFrame(stream, peer, frame)
  return e
}

/** 采集 channel 快照(agents 含队列上下文;queue 总览) */
export function buildSnapshot(manager: AgentChannelManager, channelId: string): Record<string, unknown> | null {
  const internal = internalsOf(manager)
  const channel = internal.deps.repos.channels.findById(channelId)
  if (!channel) return null
  const memberRows = internal.deps.repos.channelAgents.listByChannel(channelId)
  const agents = memberRows.map((m) => {
    const rt = internal.agentIndex.get(`${channelId}\u0000${m.id}`)
    const view = rt ? rt.getQueueView() : internal.getTaskEngine().queueViewOf(channelId, m.id)
    return {
      agentId: m.id,
      name: m.name,
      role: m.role,
      harness: m.harness,
      enabled: m.enabled,
      config: parseJson<Record<string, unknown>>(m.configJson, {}),
      state: rt ? rt.getState() : 'idle',
      currentTaskId: view.current?.id ?? null,
      currentTaskTitle: view.current?.title ?? null,
      currentTaskProgress: view.current?.progress != null ? view.current.progress : null,
      queued: view.queued.length,
      completed: view.completed.length,
      supervision: rt?.getSupervisionStatus?.(),
      continuity: rt?.getContinuity?.(),
    }
  })
  const tasks = internal.getTaskEngine().list(channelId)
  const rootQueue = rootQueueViewOf(internal.getTaskEngine().rootQueue(channelId))
  const recentMessages = internal.deps.repos.messages.listRecentByChannel(channelId, 50).map(rowToMessage)
  // queue 总览 = agents 的队列上下文规范化(与 queueOverview 同口径,免异步)
  const queue = agents.map(a => ({
    agentId: a.agentId,
    name: a.name,
    role: a.role,
    state: a.state,
    currentTaskId: a.currentTaskId ?? null,
    currentTaskTitle: a.currentTaskTitle ?? null,
    currentTaskProgress: a.currentTaskProgress ?? null,
    queuedCount: a.queued ?? 0,
    completedCount: a.completed ?? 0,
  }))
  return { channelId, channel, agents, tasks, rootQueue, queue, messages: recentMessages }
}

/**
 * 根任务队列 → 只读 AEP 投影(§2.2/§3.4)。
 * 排队位次由后端派生(position 从 2 起):前端不再自行推导 active root,
 * 避免前后端对「谁在跑」给出相反结论。
 */
export function rootQueueViewOf(queue: { activeRoot: WorkspaceTask | null, queuedRoots: WorkspaceTask[], completedRoots: WorkspaceTask[] }): RootQueueView {
  return {
    activeRootId: queue.activeRoot?.id ?? null,
    queuedRoots: queue.queuedRoots.map((t, i) => ({
      taskId: t.id,
      title: t.title,
      position: i + 2,
      state: t.state,
      createdAt: t.createdAt,
    })),
    completedRoots: queue.completedRoots.length,
    activeRootCount: queue.activeRoot ? 1 : 0,
    queuedRootCount: queue.queuedRoots.length,
  }
}

/** AgentEvent 五变体 → AEP 事件 */
