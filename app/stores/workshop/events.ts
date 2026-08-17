/**
 * AEP 事件缓冲:per-channel 环形(ring 2000)+ lastSeq 游标 + 派生 selectors。
 * 全部渲染组件从本 store 派生,不直接持有事件。
 */
import { defineStore } from 'pinia'
import { useUserStore } from './user'
import type { AepEnvelope } from '#shared/workshop-protocol'

const RING_CAP = 2000

export type EventFilter = 'all' | 'messages' | 'tasks' | 'team' | 'errors'

/** 过滤器 → 允许的事件类型集合 */
const FILTER_TYPES: Record<EventFilter, string[] | null> = {
  all: null,
  messages: ['agent.message', 'agent.delta', 'agent.status.message', 'a2a.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  team: ['agent.member', 'task.status'],
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
        // delta 聚合:同 agent 连续增量合并进前一条(delta 帧高频,合并后打字机渲染)
        if (e.type === 'agent.delta') {
          const last = ring.items[ring.items.length - 1]
          if (last && last.type === 'agent.delta' && last.agentId === e.agentId) {
            const prev = (last.payload as { delta: string }).delta
            ;(last.payload as { delta: string }).delta = prev + (e.payload as { delta: string }).delta
            ring.lastSeq = e.seq
            this.rings[e.channelId] = ring
            return
          }
        }
        ring.items.push(e)
        if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
        ring.lastSeq = e.seq
        this.rings[e.channelId] = ring
      }
    },
    setFilter(channelId: string, filter: EventFilter): void {
      this.filters[channelId] = filter
    },
    /**
     * 持久化历史拉取(server 驱动):刷新后从 DB 拉最近事件并填充 ring。
     * 与 WS 增量无缝衔接:仅接受 seq > 当前游标的帧(快照后游标=hub 最新,
     * 历史帧 seq ≤ 游标直接按序插入 items 不动游标;WS 后续增量正常追加)。
     */
    async loadHistory(channelId: string, limit = 200): Promise<void> {
      if (typeof window === 'undefined') return
      try {
        const res = await $fetch<{ code: number | string, data?: { items: AepEnvelope[] } }>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code !== 0 || !res.data?.items?.length) return
        const ring = this.rings[channelId] ?? { lastSeq: 0, items: [] }
        // 历史帧按 seq 升序补入(items 头部),不回退游标
        for (const e of res.data.items) {
          if (typeof e.seq !== 'number' || e.seq > ring.lastSeq) continue // 增量路径由 ingest 处理
          if (!ring.items.some(x => x.seq === e.seq)) ring.items.push(e)
        }
        ring.items.sort((a, b) => a.seq - b.seq)
        if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
        this.rings[channelId] = ring
      }
      catch { /* 历史拉取失败不阻塞实时流 */ }
    },
    setFocusAgent(channelId: string, agentId: string | null): void {
      this.focusAgents[channelId] = agentId
    },
    clear(channelId: string): void {
      Reflect.deleteProperty(this.rings, channelId)
    },
  },
})
