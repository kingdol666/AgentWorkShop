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
  /**
   * 已消费过的全部 seq(含被 delta 合并吃掉的中间 seq)——loadHistory 的
   * 去重依据:按 item.seq 精确匹配会漏掉合并帧,导致同段 delta 重复插入。
   */
  consumed: Set<number>
}

const EMPTY_RING = (): ChannelRing => ({ lastSeq: 0, items: [], consumed: new Set() })

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
        state.rings[channelId] ?? EMPTY_RING()
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
      const ring = this.rings[e.channelId] ?? EMPTY_RING()
      if (e.type === 'channel.snapshot') {
        // 全量对齐:清空 ring,游标对齐快照 seq
        this.rings[e.channelId] = { lastSeq: e.seq, items: [], consumed: new Set([e.seq]) }
        return
      }
      if (typeof e.seq === 'number' && e.seq > ring.lastSeq) {
        ring.consumed.add(e.seq)
        // delta 聚合:同 agent(+同任务)连续增量合并进前一条;跨任务增量绝不粘连
        if (e.type === 'agent.delta') {
          const last = ring.items[ring.items.length - 1]
          const sameOrigin = last
            && last.type === 'agent.delta'
            && last.agentId === e.agentId
            && (last.taskId ?? null) === (e.taskId ?? null)
          if (sameOrigin && last) {
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
        // 防泄漏:超限后从现存 items 重建(合并掉的旧 seq 允许短暂失忆——远早于 ring 窗口)
        if (ring.consumed.size > 20_000) ring.consumed = new Set(ring.items.map(i => i.seq))
        this.rings[e.channelId] = ring
      }
    },
    setFilter(channelId: string, filter: EventFilter): void {
      this.filters[channelId] = filter
    },
    /**
     * 持久化历史拉取(server 驱动):刷新后从 DB 拉最近事件并填充 ring。
     * 与 WS 增量无缝衔接:仅接受 seq ≤ 当前游标的帧;已消费过的 seq
     * (含被 delta 合并吃掉的中间 seq,经 consumed 集合识别)绝不重复插入。
     */
    async loadHistory(channelId: string, limit = 200): Promise<void> {
      if (typeof window === 'undefined') return
      try {
        const res = await $fetch<{ code: number | string, data?: { items: AepEnvelope[] } }>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code !== 0 || !res.data?.items?.length) return
        const ring = this.rings[channelId] ?? EMPTY_RING()
        // 历史帧按 seq 升序补入(items 头部),不回退游标
        for (const e of res.data.items) {
          if (typeof e.seq !== 'number' || e.seq > ring.lastSeq) continue // 增量路径由 ingest 处理
          if (ring.consumed.has(e.seq)) continue // 已消费(含合并帧)——绝不重复渲染
          ring.items.push(e)
          ring.consumed.add(e.seq)
        }
        ring.items.sort((a, b) => a.seq - b.seq)
        if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
        this.rings[channelId] = ring
      }
      catch { /* 历史拉取失败不阻塞实时流 */ }
    },
    /**
     * 向上翻页加载更早历史(beforeSeq 游标;时间线"加载更早"按钮驱动)。
     * 仅接受 seq < 当前 ring 最小 seq 的帧,插入头部;consumed 去重防御。
     * 返回 false 表示已无更早历史(按钮隐藏)。
     */
    async loadEarlier(channelId: string, limit = 200): Promise<boolean> {
      if (typeof window === 'undefined') return false
      const ring = this.rings[channelId]
      if (!ring) return false
      const minSeq = ring.items.length > 0 ? (ring.items[0]?.seq ?? 0) : ring.lastSeq
      if (minSeq <= 1) return false
      try {
        const res = await $fetch<{ code: number | string, data?: { items: AepEnvelope[], total?: number } }>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit, beforeSeq: Math.max(1, minSeq - 1) }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code !== 0 || !res.data?.items?.length) return false
        let added = 0
        for (const e of res.data.items) {
          if (typeof e.seq !== 'number' || e.seq >= minSeq) continue
          if (ring.consumed.has(e.seq)) continue
          ring.items.push(e)
          ring.consumed.add(e.seq)
          added += 1
        }
        if (added > 0) {
          ring.items.sort((a, b) => a.seq - b.seq)
          if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
          this.rings[channelId] = ring
        }
        // 返回是否可能还有更早(拉满一页视为有;由下次点击自然探底)
        return added > 0 && res.data.items.length >= limit
      }
      catch {
        return false
      }
    },

    setFocusAgent(channelId: string, agentId: string | null): void {
      this.focusAgents[channelId] = agentId
    },
    clear(channelId: string): void {
      Reflect.deleteProperty(this.rings, channelId)
    },
  },
})
