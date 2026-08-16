/**
 * AEP 事件缓冲:per-channel 环形(ring 2000)+ lastSeq 游标 + 派生 selectors。
 * 全部渲染组件从本 store 派生,不直接持有事件。
 */
import { defineStore } from 'pinia'
import type { AepEnvelope } from '#shared/workshop-protocol'

const RING_CAP = 2000

export type EventFilter = 'all' | 'messages' | 'tasks' | 'errors'

/** 过滤器 → 允许的事件类型集合 */
const FILTER_TYPES: Record<EventFilter, string[] | null> = {
  all: null,
  messages: ['agent.message', 'agent.status.message', 'a2a.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  errors: ['error'],
}

interface ChannelRing {
  lastSeq: number
  items: AepEnvelope[]
}

export const useEventsStore = defineStore('workshop.events', {
  state: () => ({
    rings: {} as Record<string, ChannelRing>,
    filters: {} as Record<string, EventFilter>,
    /** 时间线聚焦的 agent(只看该 agent 的流;null = 全部) */
    focusAgents: {} as Record<string, string | null>,
  }),
  getters: {
    ring(state) {
      return (channelId: string): ChannelRing =>
        state.rings[channelId] ?? { lastSeq: 0, items: [] }
    },
    /** 应用过滤 + agent 聚焦后的时间线(虚拟滚动/自动吸底消费) */
    timeline(state) {
      return (channelId: string): AepEnvelope[] => {
        const ring = state.rings[channelId]
        if (!ring) return []
        const filter = state.filters[channelId] ?? 'all'
        const allow = FILTER_TYPES[filter]
        const focus = state.focusAgents[channelId] ?? null
        return ring.items.filter((e) => {
          if (e.type === 'channel.snapshot') return false
          if (allow && !allow.includes(e.type)) return false
          if (focus && e.type !== 'task.status' && e.type !== 'task.progress' && e.agentId !== focus) return false
          return true
        })
      }
    },
    lastSeq(state) {
      return (channelId: string): number => state.rings[channelId]?.lastSeq ?? 0
    },
  },
  actions: {
    /** 消费一帧 AEP(连接回调入口):快照重建 ring,增量追加并推进游标 */
    ingest(e: AepEnvelope): void {
      if (!e.channelId) return
      const ring = this.rings[e.channelId] ?? { lastSeq: 0, items: [] }
      if (e.type === 'channel.snapshot') {
        // 全量对齐:清空 ring,游标对齐快照 seq
        this.rings[e.channelId] = { lastSeq: e.seq, items: [] }
        return
      }
      if (typeof e.seq === 'number' && e.seq > ring.lastSeq) {
        ring.items.push(e)
        if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
        ring.lastSeq = e.seq
        this.rings[e.channelId] = ring
      }
    },
    setFilter(channelId: string, filter: EventFilter): void {
      this.filters[channelId] = filter
    },
    setFocusAgent(channelId: string, agentId: string | null): void {
      this.focusAgents[channelId] = agentId
    },
    clear(channelId: string): void {
      Reflect.deleteProperty(this.rings, channelId)
    },
  },
})
